import { render } from "solid-js/web";
import App from "./App";

const target = document.getElementById("app");
if (target === null) {
  throw new Error("missing #app mount target");
}

render(() => <App />, target);
