import assert from "node:assert/strict";
import test from "node:test";

import {
  currentAccountProductEntitlements,
} from "../src/services/entitlement.service.js";

test("account products contain only Pro and Subscription", () => {
  const rows = [
    { id: "skin", product_slug: "tabforge-skin-bundle-wild-forge" },
    { id: "pack", product_slug: "tabforge-pack-research" },
    { id: "subscription", product_slug: "tabforge-subscription" },
    { id: "pro", product_slug: "tabforge" },
  ];

  assert.deepEqual(
    currentAccountProductEntitlements(rows).map((row) => [
      row.id,
      row.product_slug,
    ]),
    [
      ["subscription", "tabforge-subscription"],
      ["pro", "tabforge"],
    ]
  );
});

test("account products collapse historical aliases", () => {
  const rows = [
    { id: "new-subscription", product_slug: "tabforge-subscription" },
    { id: "old-collection", product_slug: "tabforge-collections" },
    { id: "old-subscription", product_slug: "tabforge-collections-subscription" },
    { id: "new-pro", product_slug: "tabforge" },
    { id: "old-pro", product_slug: "tabforge-pro" },
  ];

  assert.deepEqual(
    currentAccountProductEntitlements(rows).map((row) => [
      row.id,
      row.product_slug,
    ]),
    [
      ["new-subscription", "tabforge-subscription"],
      ["new-pro", "tabforge"],
    ]
  );
});
