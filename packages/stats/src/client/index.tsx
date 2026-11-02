import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { dashboardSession } from "./api";

// Swap the launch token for a session first, so it leaves the address bar before anything renders.
void dashboardSession();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
