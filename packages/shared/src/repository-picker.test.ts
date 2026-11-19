import { describe, expect, it } from "vitest";

import type { RepositoryChoice } from "./contracts.js";
import { filterRepositoryChoices } from "./repository-picker.js";

const choice = (name: string): RepositoryChoice => ({
  repoKey: `github.com/acme/${name.toLowerCase()}`,
  name,
  remote: `github.com/acme/${name.toLowerCase()}`,
  repoRoot: `C:/dev/${name}`,
});

const REPOSITORIES = [choice("clock-in"), choice("Web-Shop"), choice("shop-admin")];

describe("filtering the New project box's repositories", () => {
  it.each([
    ["", ["clock-in", "Web-Shop", "shop-admin"]],
    ["   ", ["clock-in", "Web-Shop", "shop-admin"]],
    ["shop", ["Web-Shop", "shop-admin"]],
    ["SHOP-a", ["shop-admin"]],
    [" clock ", ["clock-in"]],
    ["payroll", []],
  ])("keeps the repositories whose name holds %j", (query, names) => {
    expect(filterRepositoryChoices(REPOSITORIES, query).map((repository) => repository.name)).toEqual(names);
  });

  it("keeps the order it was given, which is the API's by name", () => {
    expect(filterRepositoryChoices([choice("b-app"), choice("a-app")], "app").map((repository) => repository.name)).toEqual(["b-app", "a-app"]);
  });

  it("is empty for an empty list", () => {
    expect(filterRepositoryChoices([], "anything")).toEqual([]);
  });
});
