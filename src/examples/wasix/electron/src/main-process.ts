import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';

import { closeStore, createTodo, deleteTodo, listTodos, toggleTodo } from './todos.js';
import type { CreateTodoInput, StatusFilter } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Oliphaunt Electron WASIX Todo',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return window;
}

async function runTestDriver(window: BrowserWindow) {
  if (!process.env.OLIPHAUNT_ELECTRON_E2E_DRIVER) return;
  const driver = await import(
    pathToFileURL(join(process.cwd(), '../tools/electron-test-driver.mts')).href
  );
  try {
    await driver.runElectronTodoSmoke(window);
    console.log('electron todo smoke passed');
  } finally {
    await closeStore();
  }
  app.exit(0);
}

ipcMain.handle('todos:list', (_event, filter: { search: string; status: StatusFilter }) =>
  listTodos(app.getPath('userData'), filter),
);
ipcMain.handle('todos:create', (_event, input: CreateTodoInput) =>
  createTodo(app.getPath('userData'), input),
);
ipcMain.handle('todos:toggle', (_event, id: number) => toggleTodo(app.getPath('userData'), id));
ipcMain.handle('todos:delete', (_event, id: number) => deleteTodo(app.getPath('userData'), id));

void app
  .whenReady()
  .then(async () => {
    await runTestDriver(createWindow());
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  event.preventDefault();
  closeStore()
    .catch((error) => console.error(error))
    .finally(() => app.exit(0));
});
