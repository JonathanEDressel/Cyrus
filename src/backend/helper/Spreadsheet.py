"""Minimal .xlsx reading and writing, plus CSV, on the standard library only.

An .xlsx file is a zip of XML parts, so a template writer and a flat-sheet
reader are a few hundred lines of stdlib rather than a dependency. That matters
here: the backend ships as a PyInstaller bundle, so every library added has to
be declared as a hidden import, grows the installer, and is one more thing that
can fail to bundle. openpyxl would be ~2MB and a new failure mode for what is,
in the end, one template and one flat table.

What this deliberately does NOT do: formulas, dates, styles beyond a bold
header, merged cells, or multiple data sheets on read. It reads the first
worksheet as a table with a header row, which is the shape an import wants.

CSV is handled alongside, because a good number of people will produce one —
from Google Sheets, from Numbers, from a text editor — and refusing it would be
obtuse when the parsing is already written.
"""

import csv
import io
import re
import zipfile
from xml.etree import ElementTree


#: OOXML namespaces. The spreadsheet parts all live in one, which is why the
#: reader can get away with a single prefix map.
_NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
_MAIN = _NS['m']


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def _col_letter(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA. Spreadsheet columns are base-26 with no zero."""
    letters = ''
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _xml_escape(value: str) -> str:
    return (str(value)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('"', '&quot;'))


#: Characters XML 1.0 forbids outright. A pasted address should never contain
#: one, but a corrupted clipboard can, and an unreadable file is a worse
#: outcome than a stripped character.
_ILLEGAL_XML = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


def _cell_xml(ref: str, value, bold: bool) -> str:
    """One cell. Everything is written as an inline string.

    Inline strings avoid the sharedStrings part entirely — one less part to
    declare and keep consistent — and for a template of a few dozen rows the
    size saving of a string table is irrelevant. Numbers are written as text
    too: every column here is a label, an address or a yes/no, and Excel
    quietly mangling a long numeric-looking address is a real risk.
    """
    style = ' s="1"' if bold else ''
    if value is None or value == '':
        return f'<c r="{ref}"{style}/>'
    text = _ILLEGAL_XML.sub('', str(value))
    return (f'<c r="{ref}"{style} t="inlineStr">'
            f'<is><t xml:space="preserve">{_xml_escape(text)}</t></is></c>')


def _sheet_xml(rows: list[list], widths: list[int] | None = None,
               freeze_header: bool = True) -> str:
    """A worksheet part. Row 1 is styled bold and frozen."""
    cols = ''
    if widths:
        entries = ''.join(
            f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
            for i, w in enumerate(widths))
        cols = f'<cols>{entries}</cols>'

    pane = ('<sheetViews><sheetView workbookViewId="0">'
            '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
            '</sheetView></sheetViews>') if freeze_header else ''

    body = []
    for r, row in enumerate(rows, start=1):
        cells = ''.join(
            _cell_xml(f'{_col_letter(c)}{r}', value, bold=(r == 1))
            for c, value in enumerate(row))
        body.append(f'<row r="{r}">{cells}</row>')

    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<worksheet xmlns="{_MAIN}">{pane}{cols}'
            f'<sheetData>{"".join(body)}</sheetData></worksheet>')


#: Two cell formats: 0 is the default, 1 is bold. Referenced by s="1" above.
_STYLES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<styleSheet xmlns="{_MAIN}">'
    '<fonts count="2">'
    '<font><sz val="11"/><name val="Calibri"/></font>'
    '<font><b/><sz val="11"/><name val="Calibri"/></font>'
    '</fonts>'
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="2">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '</cellXfs>'
    '</styleSheet>'
)


def write_xlsx(sheets: list[dict]) -> bytes:
    """Build an .xlsx from ``[{'name', 'rows', 'widths'?}, ...]``.

    Sheet names are sanitised because Excel refuses the characters below and
    caps names at 31 chars — a rejected workbook would be a silent failure at
    the point the user opens it, far from here.
    """
    parts: list[tuple[str, str]] = []
    sheet_entries = []
    rels = []

    for i, sheet in enumerate(sheets, start=1):
        name = re.sub(r'[\\/*?:\[\]]', ' ', str(sheet.get('name') or f'Sheet{i}'))[:31]
        parts.append((f'xl/worksheets/sheet{i}.xml',
                      _sheet_xml(sheet['rows'], sheet.get('widths'),
                                 sheet.get('freeze_header', True))))
        sheet_entries.append(
            f'<sheet name="{_xml_escape(name)}" sheetId="{i}" r:id="rId{i}"/>')
        rels.append(f'<Relationship Id="rId{i}" '
                    'Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                    f'relationships/worksheet" Target="worksheets/sheet{i}.xml"/>')

    styles_rid = len(sheets) + 1
    rels.append(f'<Relationship Id="rId{styles_rid}" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                'relationships/styles" Target="styles.xml"/>')

    overrides = ''.join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType='
        '"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(1, len(sheets) + 1))

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType='
        '"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        f'{overrides}'
        '<Override PartName="/xl/styles.xml" ContentType='
        '"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '</Types>'
    )

    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        'relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>'
    )

    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{_MAIN}" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets>{"".join(sheet_entries)}</sheets></workbook>'
    )

    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'{"".join(rels)}</Relationships>'
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        # [Content_Types].xml first — some readers expect to find it up front.
        zf.writestr('[Content_Types].xml', content_types)
        zf.writestr('_rels/.rels', root_rels)
        zf.writestr('xl/workbook.xml', workbook)
        zf.writestr('xl/_rels/workbook.xml.rels', workbook_rels)
        zf.writestr('xl/styles.xml', _STYLES_XML)
        for name, body in parts:
            zf.writestr(name, body)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

class SpreadsheetError(Exception):
    """The file could not be read as a spreadsheet at all.

    Carries a message meant for the user rather than a developer: every raise
    site is something a person hit by picking the wrong file.
    """


def _cell_text(cell, shared: list[str]) -> str:
    """Text of one cell, resolving whichever storage form it uses."""
    cell_type = cell.get('t')

    if cell_type == 'inlineStr':
        node = cell.find('m:is', _NS)
        return ''.join(t.text or '' for t in node.iter(f'{{{_MAIN}}}t')) if node is not None else ''

    value = cell.find('m:v', _NS)
    if cell_type == 's':
        # Shared string: <v> holds an index into the string table.
        try:
            return shared[int((value.text or '0').strip())]
        except (TypeError, ValueError, IndexError):
            return ''
    if value is not None:
        return (value.text or '').strip()

    # Some writers put the text directly in <is> or <t> without a type.
    node = cell.find('m:is', _NS)
    if node is not None:
        return ''.join(t.text or '' for t in node.iter(f'{{{_MAIN}}}t'))
    return ''


def _first_sheet_path(zf: zipfile.ZipFile) -> str:
    """Path of the first worksheet, following the workbook relationships.

    Not hardcoded to ``sheet1.xml``: the file name and the sheet order are
    independent, and exporters from Numbers and LibreOffice do produce
    workbooks where the first sheet is not sheet1.xml.
    """
    try:
        workbook = ElementTree.fromstring(zf.read('xl/workbook.xml'))
        rels = ElementTree.fromstring(zf.read('xl/_rels/workbook.xml.rels'))
    except (KeyError, ElementTree.ParseError):
        return 'xl/worksheets/sheet1.xml'

    rel_ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    targets = {r.get('Id'): r.get('Target') for r in rels}

    first = workbook.find('m:sheets/m:sheet', _NS)
    if first is not None:
        target = targets.get(first.get(f'{{{rel_ns}}}id'))
        if target:
            target = target.lstrip('/')
            return target if target.startswith('xl/') else f'xl/{target}'
    return 'xl/worksheets/sheet1.xml'


def read_xlsx_rows(data: bytes) -> list[list[str]]:
    """Rows of the first worksheet as lists of strings.

    Cells are placed by their column reference rather than by document order,
    because a row omits empty cells: a row whose B is blank jumps A -> C, and
    reading positionally would shift every later value one column left.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise SpreadsheetError(
            'That file is not a readable .xlsx workbook. If you saved it from '
            'another program, try exporting as CSV instead.')

    with zf:
        shared: list[str] = []
        try:
            table = ElementTree.fromstring(zf.read('xl/sharedStrings.xml'))
            for item in table.findall('m:si', _NS):
                shared.append(''.join(t.text or '' for t in item.iter(f'{{{_MAIN}}}t')))
        except (KeyError, ElementTree.ParseError):
            pass  # inline-string workbooks have no string table

        path = _first_sheet_path(zf)
        try:
            sheet = ElementTree.fromstring(zf.read(path))
        except KeyError:
            raise SpreadsheetError('That workbook has no worksheets.')
        except ElementTree.ParseError:
            raise SpreadsheetError('That workbook could not be read — the sheet is malformed.')

        rows: list[list[str]] = []
        for row in sheet.iter(f'{{{_MAIN}}}row'):
            values: dict[int, str] = {}
            for cell in row.findall('m:c', _NS):
                ref = cell.get('r') or ''
                letters = re.match(r'([A-Za-z]+)', ref)
                if not letters:
                    continue
                index = 0
                for char in letters.group(1).upper():
                    index = index * 26 + (ord(char) - 64)
                values[index - 1] = _cell_text(cell, shared)
            if values:
                width = max(values) + 1
                rows.append([values.get(i, '') for i in range(width)])
            else:
                rows.append([])
        return rows


def _looks_binary(data: bytes) -> bool:
    """True when these bytes are plainly not text.

    Needed because latin-1 decodes *anything*, so a PNG or a PDF would otherwise
    sail through into the CSV reader and come back as "the header row is wrong" —
    an answer about columns to someone who picked the wrong file entirely. A NUL
    byte never appears in a text export, and control characters in bulk are the
    other reliable signal.
    """
    sample = data[:2048]
    if b'\x00' in sample:
        return True
    printable = sum(1 for b in sample
                    if 32 <= b < 127 or b in (9, 10, 13) or b >= 160)
    return bool(sample) and printable / len(sample) < 0.85


def read_csv_rows(data: bytes) -> list[list[str]]:
    """Rows from CSV bytes, tolerating the encodings spreadsheets actually emit."""
    if _looks_binary(data):
        raise SpreadsheetError(
            'That file is not a spreadsheet or a CSV — it looks like a binary '
            'file such as an image or a PDF. Download the template and fill '
            'that in, or export your list as .xlsx or .csv.')

    text = None
    # utf-8-sig first: Excel's "CSV UTF-8" writes a BOM, and leaving it in place
    # corrupts the first header name so no column would be recognised.
    for encoding in ('utf-8-sig', 'utf-8', 'cp1252', 'latin-1'):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise SpreadsheetError('That file could not be decoded as text.')

    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=',;\t|')
    except csv.Error:
        dialect = csv.excel  # a single-column file sniffs as nothing

    # newline='' is what csv wants: it does its own line splitting, and letting
    # StringIO translate first is how a stray \r inside a quoted field turns
    # into a hard parse error.
    try:
        return [row for row in csv.reader(io.StringIO(text, newline=''), dialect)]
    except csv.Error as e:
        # Reached when the bytes aren't really tabular — a PDF, an image, a
        # truncated download. The csv module's own wording ("new-line character
        # seen in unquoted field") explains nothing to someone who just picked a
        # file, so it is replaced rather than passed through.
        raise SpreadsheetError(
            'That file could not be read as a spreadsheet or CSV. Download the '
            'template and fill that in, or export your list as .xlsx or .csv.'
        ) from e


def read_table(data: bytes, filename: str = '') -> list[list[str]]:
    """Rows from an .xlsx or CSV file, chosen by content rather than name.

    Content first because the extension lies often enough to matter: a file
    saved as .xlsx from a script is frequently CSV, and "PK" is an unambiguous
    signal that this really is a zip.
    """
    if data[:2] == b'PK':
        return read_xlsx_rows(data)
    if filename.lower().endswith(('.csv', '.txt', '.tsv')):
        return read_csv_rows(data)
    # Not a zip and no CSV-ish name: still try CSV, since that is the only other
    # thing it can usefully be, and the error from there is the clearer one.
    return read_csv_rows(data)


#: Leading characters that make Excel/Sheets treat a cell as a formula.
_FORMULA_LEADS = ('=', '+', '-', '@', '\t', '\r')


def _csv_cell(value) -> str:
    """One cell as text, defused against formula injection.

    Numbers pass through untouched — a negative gain must stay a number, not
    become the text "'-12.5". Only TEXT that starts like a formula is prefixed
    with an apostrophe, which spreadsheets show as nothing and treat as "this
    is text". Exchange-supplied strings (labels, ids) are the risk here.
    """
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if text.startswith(_FORMULA_LEADS):
        return "'" + text
    return text


def write_csv(headers: list[str], rows: list[list]) -> bytes:
    """CSV bytes with a UTF-8 BOM, so Excel opens it as UTF-8 instead of cp1252."""
    buffer = io.StringIO(newline='')
    writer = csv.writer(buffer, lineterminator='\r\n')
    writer.writerow([_csv_cell(h) for h in headers])
    for row in rows:
        writer.writerow([_csv_cell(cell) for cell in row])
    return ('﻿' + buffer.getvalue()).encode('utf-8')
