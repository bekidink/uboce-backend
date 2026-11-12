-- New promotions are not advertised unless the seller says so (the service advertises automatic offers).
ALTER TABLE "promotions" ALTER COLUMN "advertised" SET DEFAULT false;

-- Coupon codes created before "advertised" existed were never meant to be public: the column's old
-- default (true) put them on the marketplace. Hide them; sellers can advertise them again.
UPDATE "promotions" SET "advertised" = false WHERE "code" IS NOT NULL AND "created_at" < '2026-10-28 09:03:00+00';
