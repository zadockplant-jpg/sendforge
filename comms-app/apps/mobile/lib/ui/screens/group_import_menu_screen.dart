import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../colors.dart';
import '../theme/sf_theme.dart';
import 'add_contact_screen.dart';

class GroupImportMenuScreen extends StatelessWidget {
  final AppState appState;
  const GroupImportMenuScreen({super.key, required this.appState});

  void _toast(BuildContext context, String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg)),
    );
  }

  Widget _menuButton({
    required BuildContext context,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      child: FilledButton(
        onPressed: onTap,
        style: FilledButton.styleFrom(
          backgroundColor: Colors.white,
          foregroundColor: SFColors.textPrimary,
          side: const BorderSide(color: SFColors.cardBorder),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(SFTheme.radiusLg),
          ),
          padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 14),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    style: const TextStyle(
                      color: SFColors.textMuted,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: SFColors.textMuted),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // Match your global header style: gradient AppBar like HomeScreen
      appBar: AppBar(
        elevation: 0,
        flexibleSpace: Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [SFColors.headerBlueDark, SFColors.headerBlueLight],
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
            ),
          ),
        ),
        title: const Text(
          'Import Contacts',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        foregroundColor: Colors.white,
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            _menuButton(
              context: context,
              title: 'Import from Google Contacts',
              subtitle: 'OAuth + sync later (UI ready now)',
              onTap: () => _toast(context, 'Google import UI only (logic later)'),
            ),
            _menuButton(
              context: context,
              title: 'Import CSV',
              subtitle: 'File parsing later (UI ready now)',
              onTap: () => _toast(context, 'CSV import UI only (logic later)'),
            ),
            _menuButton(
              context: context,
              title: 'Import Device Contacts',
              subtitle: 'Permissions later (UI ready now)',
              onTap: () => _toast(context, 'Device contacts UI only (logic later)'),
            ),
            _menuButton(
              context: context,
              title: 'Add Contact',
              subtitle: 'Manual contact entry',
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => AddContactScreen(appState: appState),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
