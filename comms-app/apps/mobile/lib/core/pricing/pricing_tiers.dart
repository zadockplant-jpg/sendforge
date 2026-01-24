enum PlanTier { free, pro, business }

class PricingTier {
  final PlanTier tier;
  final String title;
  final double price;
  final int monthlyRecipients;
  final int internationalSmsCap;
  final bool allowGroupReplies;
  final bool allowMultiChannel;

  const PricingTier({
    required this.tier,
    required this.title,
    required this.price,
    required this.monthlyRecipients,
    required this.internationalSmsCap,
    required this.allowGroupReplies,
    required this.allowMultiChannel,
  });
}

const pricingTiers = {
  PlanTier.free: PricingTier(
    tier: PlanTier.free,
    title: 'Free',
    price: 0,
    monthlyRecipients: 25,
    internationalSmsCap: 0,
    allowGroupReplies: false,
    allowMultiChannel: false,
  ),
  PlanTier.pro: PricingTier(
    tier: PlanTier.pro,
    title: 'Pro',
    price: 29,
    monthlyRecipients: 1000,
    internationalSmsCap: 100,
    allowGroupReplies: true,
    allowMultiChannel: true,
  ),
  PlanTier.business: PricingTier(
    tier: PlanTier.business,
    title: 'Business',
    price: 79,
    monthlyRecipients: 5000,
    internationalSmsCap: 999999,
    allowGroupReplies: true,
    allowMultiChannel: true,
  ),
};
