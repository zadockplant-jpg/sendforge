import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../colors.dart';
import '../theme/sf_theme.dart';
import 'add_contact_screen.dart';
import 'contacts_import_screen.dart'; // ✅ real CSV import screen

class GroupImportMenuScreen extends StatelessWidget {
  final AppState appState;
  const GroupImportMenuScreen({super.key, required this.appState});

  Widget _menuButton({
    required BuildContext context,
    required String title,
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
              child: Text(
                title,
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 15,
                ),
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
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _menuButton(
              context: context,
              title: 'Import from Device',
              onTap: () {
                // PASS 2: device permissions + picker
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Device contacts coming next')),
                );
              },
            ),
            _menuButton(
              context: context,
              title: 'Import from Google',
              onTap: () {
                // PASS 2: OAuth
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Google Contacts OAuth coming next')),
                );
              },
            ),
            _menuButton(
              context: context,
              title: 'Import CSV',
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => ContactsImportScreen(appState: appState),
                  ),
                );
              },
            ),
            _menuButton(
              context: context,
              title: 'Add Contact',
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => AddContactScreen(appState: appState),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
