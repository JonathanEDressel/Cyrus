document.getElementById('node-version')!.innerText = process.versions.node;
document.getElementById('chrome-version')!.innerText = process.versions.chrome;
document.getElementById('electron-version')!.innerText = process.versions.electron;

const button = document.getElementById('demo-button');
const result = document.getElementById('result');

button?.addEventListener('click', () => {
  result!.innerText = '✨ Hello from Electron! ✨';
});
