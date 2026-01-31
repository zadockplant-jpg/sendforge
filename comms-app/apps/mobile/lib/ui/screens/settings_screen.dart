import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../colors.dart';
import '../icons.dart';
import '../pricing/pricing_plans.dart';

class SettingsScreen extends StatelessWidget {
  final AppState appState;
  const SettingsScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    final current = PricingPlans.byTier(appState.planTier);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _SectionHeader('Account'),
          ListTile(
            leading: const Icon(Icons.person),
            title: const Text('Account'),
            subtitle: const Text('Email, security, preferences'),
            onTap: () {},
          ),

          _SectionHeader('Plan & Usage'),
          ListTile(
            leading: Icon(SFIcons.billing, color: SFColors.accentAmber),
            title: Text('Subscription (${current.name})'),
            subtitle: Text('\$${current.monthlyUsd}/mo • ${current.tagline}'),
            onTap: () {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => PricingScreen(appState: appState)),
              );
            },
          ),
          ListTile(
            leading: const Icon(Icons.bar_chart),
            title: const Text('Usage'),
            subtitle: const Text('Messages sent this month (MVP local)'),
            onTap: () {},
          ),

          _SectionHeader('Support'),
          ListTile(
            leading: const Icon(Icons.help_outline),
            title: const Text('Help'),
            onTap: () {},
          ),
        ],
      ),
    );
  }
}

class PricingScreen extends StatelessWidget {
  final AppState appState;
  const PricingScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    final plans = PricingPlans.all;

    return Scaffold(
      appBar: AppBar(title: const Text('Pricing')),
      body: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: plans.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (_, i) {
          final p = plans[i];
          final selected = appState.planTier == p.tier;

          return Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: selected ? SFColors.primaryBlue : SFColors.cardBorder),
              color: Colors.white,
            ),
            child: ListTile(
              title: Text(
                '${p.name} — \$${p.monthlyUsd}/mo',
                style: TextStyle(
                  fontWeight: FontWeight.w800,
                  color: selected ? SFColors.primaryBlue : SFColors.textPrimary,
                ),
              ),
              subtitle: Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(p.tagline),
                    const SizedBox(height: 8),
                    ...p.bullets.map((b) => Text('• $b')),
                  ],
                ),
              ),
              trailing: selected ? const Icon(Icons.check_circle) : null,
              onTap: () {
                appState.setPlanTier(p.tier);
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Selected ${p.name} (UI only for now)')),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String text;
  const _SectionHeader(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 24, bottom: 8),
      child: Text(
        text,
        style: const TextStyle(
          fontWeight: FontWeight.bold,
          color: SFColors.textMuted,
        ),
      ),
    );
  }
}
