import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installerNote, macInstallerNote, macInstallerUrl, windowsInstallerUrl } from "./DownloadInstaller.js";
import { InstallTabs } from "./InstallTabs.js";

const WINDOWS_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAC_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const LINUX_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const browseFrom = (userAgent: string): void => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InstallTabs", () => {
  it.each([
    { from: "Windows", userAgent: WINDOWS_USER_AGENT, expectedTab: "Windows" },
    { from: "a Mac", userAgent: MAC_USER_AGENT, expectedTab: "Mac" },
    { from: "Linux", userAgent: LINUX_USER_AGENT, expectedTab: "Windows" },
  ])("opens on $expectedTab for a visitor browsing from $from", ({ userAgent, expectedTab }) => {
    // Arrange
    browseFrom(userAgent);

    // Act
    render(<InstallTabs />);

    // Assert
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(expectedTab);
  });

  it("offers the signed Windows release and says who signed it", () => {
    // Arrange
    browseFrom(WINDOWS_USER_AGENT);

    // Act
    render(<InstallTabs />);

    // Assert
    const panel = screen.getByRole("tabpanel", { name: "Windows" });
    const download = within(panel).getByRole("link", { name: "Download for Windows" });
    expect(download).toHaveAttribute("href", windowsInstallerUrl);
    expect(download).toHaveAccessibleDescription(installerNote);
    expect(panel).toHaveTextContent("For 64-bit Windows. Updates install themselves.");
  });

  it("offers the signed Mac release and says how it is signed", () => {
    // Arrange
    browseFrom(MAC_USER_AGENT);

    // Act
    render(<InstallTabs />);

    // Assert
    const panel = screen.getByRole("tabpanel", { name: "Mac" });
    const download = within(panel).getByRole("link", { name: "Download for Mac" });
    expect(download).toHaveAttribute("href", macInstallerUrl);
    expect(download).toHaveAccessibleDescription(macInstallerNote);
    expect(panel).toHaveTextContent("Signed with an Apple Developer ID and notarized by Apple, for Apple silicon and Intel Macs.");
  });

  // The Mac build is signed with a Developer ID that is not SIQstack LLC's.
  it("names no company as the Mac build's signer and no longer says it is coming", () => {
    // Arrange
    browseFrom(MAC_USER_AGENT);

    // Act
    render(<InstallTabs />);

    // Assert
    const panel = screen.getByRole("tabpanel", { name: "Mac" });
    expect(panel).not.toHaveTextContent("SIQstack LLC");
    expect(panel).not.toHaveTextContent("Coming soon");
  });

  it("says plainly what differs on a Mac", () => {
    // Arrange
    browseFrom(MAC_USER_AGENT);

    // Act
    render(<InstallTabs />);

    // Assert
    const panel = screen.getByRole("tabpanel", { name: "Mac" });
    for (const difference of [/Documents, Desktop and Downloads/, /opens at login/, /Music on its own/, /macOS 14 or later/]) {
      expect(panel).toHaveTextContent(difference);
    }
  });

  it("says both systems record into the same workspace", () => {
    // Arrange
    browseFrom(WINDOWS_USER_AGENT);

    // Act
    const { container } = render(<InstallTabs />);

    // Assert
    expect(container).toHaveTextContent(/same workspace/);
  });

  it("switches system when a tab is clicked", async () => {
    // Arrange
    browseFrom(WINDOWS_USER_AGENT);
    const person = userEvent.setup();
    render(<InstallTabs />);

    // Act
    await person.click(screen.getByRole("tab", { name: "Mac" }));

    // Assert
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Mac");
  });

  it("moves between systems with the arrow keys, Home and End, wrapping at either end", async () => {
    // Arrange
    browseFrom(WINDOWS_USER_AGENT);
    const person = userEvent.setup();
    render(<InstallTabs />);
    await person.tab();
    const steps = [
      { key: "{ArrowRight}", expectedTab: "Mac" },
      { key: "{ArrowRight}", expectedTab: "Windows" },
      { key: "{ArrowLeft}", expectedTab: "Mac" },
      { key: "{Home}", expectedTab: "Windows" },
      { key: "{End}", expectedTab: "Mac" },
    ];

    for (const { key, expectedTab } of steps) {
      // Act
      await person.keyboard(key);

      // Assert
      const selected = screen.getByRole("tab", { selected: true });
      expect(selected).toHaveAccessibleName(expectedTab);
      expect(selected).toHaveFocus();
    }
  });

  it("keeps only the selected tab in the tab order", () => {
    // Arrange
    browseFrom(MAC_USER_AGENT);

    // Act
    render(<InstallTabs />);

    // Assert
    expect(screen.getByRole("tab", { name: "Mac" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Windows" })).toHaveAttribute("tabindex", "-1");
  });
});
