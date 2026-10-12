import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge across contextIsolation. `desktop` lets the page leave reminders to
 * the main process (which can notify with no window open) and make room for the
 * macOS window buttons; `pickFolder` is a native folder picker for importing. In a
 * plain browser tab this object is simply absent.
 */
contextBridge.exposeInMainWorld("lockin", {
  desktop: true,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("lockin:pickFolder"),
});
