import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import 'csv_import_screen.dart';
import 'device_import_screen.dart';
import 'google_contacts_import_screen.dart';
import 'manual_add_contact_screen.dart';

class ImportContactsScreen extends StatelessWidget {
  final AppState appState;
  const ImportContactsScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Import Contacts')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _button(
              label: 'Import from Device',
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => DeviceContactsImportScreen(appState: appState),
                ),
              ),
            ),
            const SizedBox(height: 10),
            _button(
              label: 'Import from Google',
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => GoogleContactsImportScreen(appState: appState),
                ),
              ),
            ),
            const SizedBox(height: 10),
            _button(
              label: 'Import CSV',
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => CsvImportScreen(appState: appState),
                ),
              ),
            ),
            const SizedBox(height: 10),
            _button(
              label: 'Add Contact',
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => ManualAddContactScreen(appState: appState),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _button({required String label, required VoidCallback onTap}) {
    return SizedBox(
      width: double.infinity,
      child: FilledButton(
        onPressed: onTap,
        style: FilledButton.styleFrom(
          alignment: Alignment.centerLeft, // left align label inside button
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
        ),
        child: Text(
          label,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}
