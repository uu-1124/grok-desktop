import { createRoot } from "react-dom/client";
import App from "./App";
import { resolveTheme } from "./lib/theme";
import "./styles.css";

const initialTheme = resolveTheme(
  "system",
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);
document.documentElement.dataset.theme = initialTheme;
document.documentElement.style.colorScheme = initialTheme;

const root = document.getElementById("root");

if (!root) {
  throw new Error("无法找到应用挂载节点");
}

createRoot(root).render(<App />);
