# PRD Addendum v1.1 — implementation status

What the addendum asks for, what the backend (`uboce`) and web app (`uboce-web`) already do, and how the rest gets built.
✅ done · 🟡 partial · ❌ missing. Priorities follow the addendum (P0 first).

## 2.1 Business structure and locations — 🟡 → mostly ✅

| Requirement | Status | Where / how |
|---|---|---|
| Organization types (farm, cooperative, manufacturer, wholesaler, distributor, warehouse, logistics…) | ✅ | `organization` `OrganizationType` |
| Operating model: wholesale, retail, made-to-order, hybrid | ✅ | `Organization.businessModels` (several = hybrid); Settings → Organization |
| Contact details | ✅ | `contactPhone`, `contactEmail` |
| Locations: head office, store, warehouse, collection point, production site | ✅ | `Branch.kind`; `GET/POST/PATCH /organizations/:id/branches[/:branchId]` |
| Operating hours, contacts, service areas, pickup / fulfilment flags, deactivate | ✅ | `Branch.operatingHours`, `phone`, `email`, `serviceAreas`, `pickupEnabled`, `fulfillment`, `active` |
| Warehouses tied to a location | ✅ | `warehouse.Warehouse.branchId` |
| Warehouse bins, receipts, transfers, reservations, adjustments with reason codes | ✅ | `warehouse`, `inventory` |
| Cycle counts; damaged / quarantined stock states | ❌ | Inventory: `StockState` (available/damaged/quarantined) on balances + `CycleCount` with variance posting as adjustments |
| Location-specific pricing | ❌ | Pricing service (2.4): price list scoped to a `branchId` |
| Order fulfilment location assignment with audit trail | ❌ | Commerce: `SalesOrder.fulfillmentBranchId` + `OrderEvent` row on each change |

## 2.2 Staff and permissions — 🟡 → mostly ✅

| Requirement | Status | Where / how |
|---|---|---|
| Invite, add, remove staff; fixed roles | ✅ | `organization` memberships + invitations |
| Suspend / reactivate | ✅ | `POST …/members/:id/suspend` and `/reactivate`; suspended = no access in any service, role and scope kept |
| Location-scoped access | ✅ | `PUT …/members/:id/locations`; `InternalMembership.locationIds`; `requireLocation()` / `locationScope()` in `@uboce/common`; enforced in Warehouse (warehouses, receipts, transfers) |
| Audit of staff changes | ✅ | `MembershipUpdated` event (role, status, locations, who changed it) |
| Scope enforcement in other location-bound services | ❌ | Apply `locationScope()` in Inventory, Logistics and Commerce once their records carry a `branchId` |
| Role templates as data, module + action + scope permissions | ❌ | Organization: `RoleTemplate { permissions: string[] }`, membership references a template; `requireRole` → `requirePermission('orders:approve')` |
| Approval limits, separation of duties | ❌ | `RoleTemplate.approvalLimit`; Procurement/Finance check amount and "creator ≠ approver" |

## 2.3 Catalog — 🟡

| Requirement | Status | How |
|---|---|---|
| Categories with required attributes, products, variants (SKU, price, MOQ) | ✅ | `catalog` |
| Typed attribute definitions (number/enum/unit, validation, filterable) | ❌ | `CategoryAttribute { key, type, unit, options[], required, filterable }` replacing `requiredAttributes: string[]`; validate product attributes against it |
| Product media (primary image, order, alt text) | ❌ | `ProductMedia { documentId, position, alt }` using the Document service |
| Barcode, pack size, batch / expiry tracking flag | ❌ | Variant columns; batch/expiry on inventory movements |
| Bulk price tiers, add-ons / option groups | ❌ | `VariantPriceTier { minQty, unitPrice }`; `OptionGroup` + `Option { priceDelta }` |
| Order-line snapshot of product at purchase | 🟡 | Lines keep description/price/unit; add `productSnapshot Json` (SKU, attributes, image, policy version) |
| Direct-order prices taken from the catalog, not the client | ❌ | Commerce resolves the variant price (and tier) server-side |

## 2.4 Pricing and promotions — ❌

New **pricing** service (or a module in Catalog): price lists (per buyer group / location / currency), volume tiers, promotions (percent/fixed, date window, budget), coupons with usage limits, and a `POST /pricing/quote` used by Commerce at checkout. Seasonal availability + pre-orders: `availableFrom/Until` on products and a `preorder` order flag.

## 2.5 Quality and ratings — 🟡

| Requirement | Status | How |
|---|---|---|
| Inspections, decisions, nonconformances, inspection holds | ✅ | `quality`, `warehouse` |
| Supplier performance metrics | ✅ | `analytics` (`formulaVersion`) |
| Quality specs / certifications per product | ❌ | `QualitySpec` linked to product; certificates as documents with expiry |
| Quality claims from buyers | ❌ | `QualityClaim` (order line, evidence documents, status) → may open a dispute or a refund request |
| Verified reviews (business and product), moderation, supplier replies | ❌ | `Review` allowed only for a delivered order; `status: pending/published/hidden`; `reply` |
| Scorecard snapshots | ❌ | Monthly job storing the metrics per supplier |

## 2.6 Cancellation, returns, refunds — 🟡

Have: cancellation through the order state machine, disputes with appeal, credit notes.
Missing:
- Cancellation policy versions that are snapshotted on the order at purchase.
- No-show, failed-delivery and uncollected states.
- `ReturnRequest`.
- `RefundRequest` with approval and provider status.

How to build them:
- **Commerce:** `CancellationPolicy {version, rules}` with its id stored on the order, plus the new states.
- **Finance:** `Refund` linked to a credit note and the payment provider.

## 2.7 Payments — 🟡

Have:
- Signed, idempotent provider webhooks.
- Payment claims and confirmation.
- Reconciliation to invoices.

Missing:
- A provider adapter interface (Chapa / telebirr / Stripe).
- `PaymentIntent` and attempts.
- Fees, refunds through the provider, settlement records, reconciliation runs.

How to build them: in Finance, add a `PaymentProvider` interface with one adapter per provider, keyed by `provider`; the Integration webhooks then update the intents.

## 2.8 Logistics — 🟡

Have:
- Split shipments per order, tracking, carrier webhooks, exceptions.
- Proof of delivery with documents.

Missing:
- Multi-order consolidated shipments.
- More shipment states: planned, assigned, ready for pickup, picked up, delayed.
- Pickup windows, freight responsibility (incoterm-like).
- Packages, carriers, vehicles and drivers, with driver-only access.

How to build them: in Logistics, add `ShipmentOrder` (many-to-many), `Package`, `Vehicle`, `Driver`, and `DriverAssignment`. Drivers are members with a `driver` role and see only the shipments assigned to them.

## 2.9 Chat — ❌

New **communication** service:
- `Conversation`, linked to an RFQ, order or dispute, with participant organizations.
- `Message`, with document attachments.
- Read receipts.
- Notifications through the existing Notification events.
- Polling at first, then SSE.

## 2.10 Module registry and entitlements — ❌ (feature flags only)

Administration:
- `Module` registry.
- `Entitlement { organizationId, moduleKey, until }`.

Common:
- A `RequiresModule('logistics')` guard with a short cache.

Web:
- The sidebar hides modules the organization isn't entitled to.

## 2.11 Search, reports, AI — 🟡

Have:
- Full-text search with category, verified, price and supplier filters.
- Analytics summary and time series.

Missing:
- Typo tolerance and synonyms (`pg_trgm`).
- Facets.
- Filters for MOQ, stock, rating, delivery area and season.
- Location-level reports.
- AI report summaries with citations (Claude API, numbers taken only from the report rows).

## NFRs

Met:
- Tenant isolation.
- Outbox/inbox events with IDs.
- Webhook signatures and idempotency.
- Admin audit log.

Location-scope isolation:
- Enforced in Organization and Warehouse.
- The rest follows as each service gets location fields.

## Implementation order

1. **Done:** business model, locations, suspension, location-scoped staff, warehouse scope (`pnpm smoke:locations`, 21 checks).
2. **P0 next:**
   - Catalog: typed attributes, media, price tiers.
   - Commerce: server-side pricing and order snapshots.
   - Cancellation policy versions.
   - Basic verified reviews.
   - Store reports per location.
3. **P1:**
   - Pricing/promotions service.
   - Refunds and returns.
   - Payment provider adapters.
   - Logistics fleet and drivers.
   - Module entitlements.
4. **P2:**
   - Chat.
   - Search facets/typos.
   - AI summaries.
   - Scorecard snapshots.
