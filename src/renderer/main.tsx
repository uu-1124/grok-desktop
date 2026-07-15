import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("无法找到应用挂载节点");
}

createRoot(root).render(<App />);
