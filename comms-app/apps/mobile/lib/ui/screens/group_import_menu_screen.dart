import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../colors.dart';
import '../theme/sf_theme.dart';
import 'add_contact_screen.dart';
import 'contacts_import_screen.dart';
import 'device_import_screen.dart';
import 'google_csv_instructions_screen.dart';

class GroupImportMenuScreen extends StatelessWidget {
  final AppState appState;
  const GroupImportMenuScreen({super.key, required this.appState});

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
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    style: const TextStyle(color: SFColors.textMuted, fontSize: 12),
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
        title: const Text('Import Contacts', style: TextStyle(fontWeight: FontWeight.w700)),
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
              subtitle: 'Reads contacts from your phone (permission required)',
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => DeviceContactsImportScreen(appState: appState),
                  ),
                );
              },
            ),
            _menuButton(
              context: context,
              title: 'Import from Google',
              subtitle: 'OAuth deferred → export CSV from Google Contacts',
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => GoogleCsvInstructionsScreen(appState: appState),
                  ),
                );
              },
            ),
            _menuButton(
              context: context,
              title: 'Import CSV',
              subtitle: 'Pick a CSV file → preview → import to SendForge',
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
              subtitle: 'Manual entry (writes to backend)',
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
