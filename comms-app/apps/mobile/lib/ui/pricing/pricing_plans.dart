class PricingPlan {
  final String tier; // free | pro | business
  final String name;
  final int monthlyUsd;
  final String tagline;
  final List<String> bullets;

  const PricingPlan({
    required this.tier,
    required this.name,
    required this.monthlyUsd,
    required this.tagline,
    required this.bullets,
  });
}

class PricingPlans {
  static const free = PricingPlan(
    tier: 'free',
    name: 'Free',
    monthlyUsd: 0,
    tagline: 'Get started with basic messaging',
    bullets: [
      'Up to 100 messages / month',
      'Manual contact entry',
      'Basic group messaging',
      'Community support',
    ],
  );

  static const pro = PricingPlan(
    tier: 'pro',
    name: 'Pro',
    monthlyUsd: 29,
    tagline: 'For growing teams and creators',
    bullets: [
      'Up to 2,000 messages / month',
      'Priority support',
    ],
  );

  static const business = PricingPlan(
    tier: 'business',
    name: 'Business',
    monthlyUsd: 79,
    tagline: 'High-volume messaging at scale',
    bullets: [
      'Up to 5,000 messages / month',
      'Dedicated support',
    ],
  );

  static const List<PricingPlan> all = [free, pro, business];

  static PricingPlan byTier(String tier) {
    return all.firstWhere(
      (p) => p.tier == tier,
      orElse: () => free,
    );
  }
}
