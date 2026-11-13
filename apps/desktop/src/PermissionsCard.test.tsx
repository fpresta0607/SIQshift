import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PermissionStatus } from "./bridge.js";
import { PermissionsCard } from "./PermissionsCard.js";

const cardFor = (permissions: PermissionStatus[], overrides: Partial<Parameters<typeof PermissionsCard>[0]> = {}) => {
  const props = {
    permissions,
    busy: undefined,
    error: undefined,
    onAsk: vi.fn(),
    onDecline: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
  render(<PermissionsCard {...props} />);
  return props;
};

describe("PermissionsCard", () => {
  it.each<[string, PermissionStatus[]]>([
    ["no permissions (every platform but macOS)", []],
    ["every grant settled", [
      { id: "login-item", state: "granted" },
      { id: "protected-folders", state: "declined" },
    ]],
  ])("stays off the main screen with %s", (_case, permissions) => {
    // Act
    cardFor(permissions);

    // Assert
    expect(screen.queryByTestId("permissions-card")).not.toBeInTheDocument();
  });

  it("names a missing grant, what goes unrecorded, and opens its settings pane", async () => {
    // Arrange
    const person = userEvent.setup();
    const props = cardFor([
      { id: "login-item", state: "missing" },
      { id: "protected-folders", state: "granted" },
    ]);

    // Act
    const row = screen.getByTestId("permission-login-item");
    await person.click(within(row).getByRole("button", { name: "Open Login Items" }));

    // Assert
    expect(row).toHaveTextContent("Not allowed");
    expect(row).toHaveTextContent("nothing is recorded until you open it");
    expect(props.onOpenSettings).toHaveBeenCalledWith("login-item");
    const folders = screen.getByTestId("permission-protected-folders");
    expect(folders).toHaveTextContent("Allowed");
    expect(within(folders).getByRole("button", { name: "Open Files and Folders" })).toBeInTheDocument();
    expect(screen.getByTestId("permissions-card")).toHaveTextContent("recorded without any permission");
  });

  it("offers to ask for unasked folders, or to say they are not needed", async () => {
    // Arrange
    const person = userEvent.setup();
    const props = cardFor([
      { id: "login-item", state: "granted" },
      { id: "protected-folders", state: "not-asked" },
    ]);
    const row = screen.getByTestId("permission-protected-folders");

    // Act
    await person.click(within(row).getByRole("button", { name: "Ask now" }));
    await person.click(within(row).getByRole("button", { name: "My code isn't kept there" }));

    // Assert
    expect(row).toHaveTextContent("Not asked yet");
    expect(row).toHaveTextContent("aren't linked to your shifts");
    expect(props.onAsk).toHaveBeenCalledWith("protected-folders");
    expect(props.onDecline).toHaveBeenCalledWith("protected-folders");
    expect(within(row).queryByRole("button", { name: "Open Files and Folders" })).not.toBeInTheDocument();
  });

  it("holds the row while macOS is asking and shows a failed action", () => {
    // Act
    cardFor(
      [{ id: "protected-folders", state: "not-asked" }],
      { busy: "protected-folders", error: "SIQshift could not save your answer." },
    );

    // Assert
    expect(screen.getByRole("button", { name: "Waiting for macOS…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "My code isn't kept there" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("SIQshift could not save your answer.");
  });
});
