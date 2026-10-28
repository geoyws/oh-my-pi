import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { dashboardToken } from "./api";

// Adopt the launch token first so it leaves the address bar before anything renders.
dashboardToken();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
