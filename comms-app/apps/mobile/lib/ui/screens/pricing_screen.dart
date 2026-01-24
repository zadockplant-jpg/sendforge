class PricingTier {
  final String tier; // free | pro | business
  final String title;
  final int price; // USD / month
  final int monthlyRecipients;

  /// International SMS cap included in plan
  /// 0 = not allowed
  final int internationalSmsCap;

  /// Optional descriptive copy (UI only)
  final String description;

  const PricingTier({
    required this.tier,
    required this.title,
    required this.price,
    required this.monthlyRecipients,
    required this.internationalSmsCap,
    required this.description,
  });
}

const Map<String, PricingTier> pricingTiers = {
  'free': PricingTier(
    tier: 'free',
    title: 'Free',
    price: 0,
    monthlyRecipients: 25,
    internationalSmsCap: 0,
    description:
        'Onboarding tier to explore SendForge. Designed to encourage upgrade.',
  ),

  'pro': PricingTier(
    tier: 'pro',
    title: 'Pro',
    price: 29,
    monthlyRecipients: 1000,
    internationalSmsCap: 100,
    description:
        'Core plan for teams sending regularly. Includes limited international SMS.',
  ),

  'business': PricingTier(
    tier: 'business',
    title: 'Business',
    price: 79,
    monthlyRecipients: 5000,
    internationalSmsCap: 1000,
    description:
        'High-volume sending with full international support and lower overage risk.',
  ),
};
