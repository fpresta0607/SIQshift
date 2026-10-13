import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest is not running with globals, so Testing Library's automatic cleanup
// never registers. Without this, each render stacks onto the previous DOM.
afterEach(cleanup);

// jsdom does not implement native dialogs; browser coverage verifies focus and Escape.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
