const webdriverTimeoutMs = 90_000;

export function installElectronTodoTestDriver({ app, window, close }) {
  if (!process.send) {
    throw new Error("Electron test driver requires an IPC stdio channel");
  }

  process.on("message", async (message) => {
    if (!message || typeof message !== "object") return;
    const { id, command } = message;
    if (typeof id !== "number" || typeof command !== "string") return;

    try {
      let value;
      if (command === "ready") {
        await waitForWindowLoad(window);
        value = window.webContents.getURL();
      } else if (command === "runTodoSmoke") {
        await waitForWindowLoad(window);
        value = await runTodoSmoke(window);
      } else if (command === "shutdown") {
        await close();
        process.send?.({ id, ok: true, value: "closed" });
        app.exit(0);
        return;
      } else {
        throw new Error(`unknown Electron test driver command: ${command}`);
      }
      process.send?.({ id, ok: true, value });
    } catch (error) {
      process.send?.({
        id,
        ok: false,
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
    }
  });

  process.send({ event: "driver-ready" });
}

async function waitForWindowLoad(window) {
  if (!window.webContents.isLoading()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for window load")), 30_000);
    window.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
    window.webContents.once("did-fail-load", (_event, _code, description) => {
      clearTimeout(timer);
      reject(new Error(`window failed to load: ${description}`));
    });
  });
}

async function runTodoSmoke(window) {
  return window.webContents.executeJavaScript(
    `(${rendererTodoSmoke.toString()})(${JSON.stringify(webdriverTimeoutMs)})`,
    true,
  );
}

async function rendererTodoSmoke(timeoutMs) {
  const title = `Ship Electron e2e ${Date.now()}`;
  const notes = "created by Electron test driver";

  const required = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`missing selector: ${selector}`);
    return element;
  };
  const setValue = (selector, value) => {
    const element = required(selector);
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}; body was: ${document.body.innerText}`);
  };

  await waitFor(() => Boolean(window.todos), "preload todo API");
  await waitFor(
    () => required("#todo-list").textContent?.includes("No todos match the current filter."),
    "initial todo list",
  );

  setValue("#title", title);
  setValue("#notes", notes);
  setValue("#area", "examples");
  setValue("#context", "local registry");
  setValue("#priority", "1");
  required("button[type='submit']").click();

  await waitFor(() => document.body.innerText.includes(title), "created todo title");
  await waitFor(() => document.body.innerText.includes(notes), "created todo notes");

  required("article.todo input[type='checkbox']").click();
  await waitFor(() => required("#open-count").textContent?.includes("0 open"), "todo toggle");
  required("[data-status='done']").click();
  await waitFor(
    () => document.querySelector("article.todo.done")?.textContent?.includes(notes) === true,
    "done todo filter",
  );

  return document.body.innerText;
}
