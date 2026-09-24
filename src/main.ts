import "./ui/style.css";
import { App } from "./ui/app";

new App().start().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<div style="position:fixed;inset:auto 20px 20px 20px;padding:12px;background:#3a0d14;color:#fff;border-radius:10px;z-index:99">Failed to start: ${String(err)}</div>`);
});
