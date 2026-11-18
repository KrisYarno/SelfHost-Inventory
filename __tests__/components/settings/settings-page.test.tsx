/** @jest-environment jsdom */
//
// Facelift F0-9 (plan 2026-11-17-facelift-f0, F0-9) — Settings shows only
// settings that do something.
//
// Before: display mode, date format, time format, items per page and
// auto-refresh were saved to localStorage under `appSettings`, and nothing in
// the app ever read them (a repo-wide grep found `appSettings` only in this
// page). The About card hard-coded "v1.0.0" and "© 2024". Now the page is the
// theme control (which next-themes does apply) and the About card.

import * as React from "react";
import fs from "fs";
import path from "path";
import { fireEvent, render, screen } from "@testing-library/react";

const mockSetTheme = jest.fn();
jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: mockSetTheme }) }));

import SettingsPage from "@/app/(app)/settings/page";

beforeEach(() => {
  mockSetTheme.mockReset();
  window.localStorage.clear();
});

describe("F0-9 — Application Settings", () => {
  it("renders only the theme control: three theme radios, no other control", () => {
    render(<SettingsPage />);

    expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const name of ["Light", "Dark", "System"]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }

    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    for (const gone of [/Display Mode/, /Date Format/, /Time Format/, /Items per page/, /Auto-refresh/, /Save Changes/]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("the theme control still sets the theme", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("writes no `appSettings` (behaviour: nothing is stored; source: the key is gone)", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(setItem.mock.calls.filter(([key]) => key === "appSettings")).toHaveLength(0);
    expect(window.localStorage.getItem("appSettings")).toBeNull();
    setItem.mockRestore();

    const source = fs.readFileSync(path.join(process.cwd(), "app/(app)/settings/page.tsx"), "utf8");
    expect(source).not.toContain("appSettings");
  });

  it("the About card drops the hard-coded version and year", () => {
    render(<SettingsPage />);
    expect(screen.getByText("About")).toBeInTheDocument();
    expect(screen.queryByText(/v1\.0\.0/)).toBeNull();
    expect(screen.queryByText(/© 2024/)).toBeNull();
  });
});
