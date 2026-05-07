"""Robinhood-specific exception hierarchy.

All exceptions raised inside the robinhood package subclass RobinhoodError so
callers can catch the base class when they don't need to distinguish subtypes.
"""


class RobinhoodError(Exception):
    """Base class for all Robinhood API errors."""


class RobinhoodAuthError(RobinhoodError):
    """Raised on 401 / 403 responses or invalid credential format."""


class RobinhoodRateLimitError(RobinhoodError):
    """Raised when the 429 retry budget is exhausted."""


class RobinhoodNotSupportedError(RobinhoodError):
    """Raised when an operation is not available via the Robinhood API."""
