import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Cards } from "./cards";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// `#cards/<name>` renders one marketing infographic at its export size (scripts/cards.mjs saves them as PNG).
const card = location.hash.startsWith("#cards/") ? location.hash.slice("#cards/".length) : null;
createRoot(root).render(<StrictMode>{card ? <Cards name={card} /> : <App />}</StrictMode>);
