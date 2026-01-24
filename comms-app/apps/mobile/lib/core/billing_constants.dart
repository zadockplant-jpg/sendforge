// apps/mobile/lib/core/billing_constants.dart
enum PlanTier { free, pro, business }

class BillingCaps {
  final int softPerBlastCents;
  final int hardAccumCents;
  const BillingCaps(this.softPerBlastCents, this.hardAccumCents);
}

const capsPro = BillingCaps(1000, 2000); // $10 / $20
const capsBusiness = BillingCaps(3000, 5000); // $30 / $50
