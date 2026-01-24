import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../colors.dart';
import '../icons.dart';

class SettingsScreen extends StatelessWidget {
  final AppState appState;
  const SettingsScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
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
            title: const Text('Subscription'),
            subtitle: const Text('Basic / Pro'),
            onTap: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Billing coming soon')),
              );
            },
          ),
          ListTile(
            leading: const Icon(Icons.bar_chart),
            title: const Text('Usage'),
            subtitle: const Text('Messages sent this month'),
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
