import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../components/sf_card.dart';

class ContactsImportScreen extends StatelessWidget {
  final AppState appState;
  const ContactsImportScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Import Contacts')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: SFCard(
          title: 'Import options (MVP UI)',
          subtitle: 'We’ll wire these after auth + permissions.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FilledButton(
                onPressed: () => _toast(context, 'Google Contacts wiring later'),
                child: const Text('Import from Google Contacts'),
              ),
              const SizedBox(height: 10),
              FilledButton(
                onPressed: () => _toast(context, 'CSV import wiring later'),
                child: const Text('Import CSV'),
              ),
              const SizedBox(height: 10),
              FilledButton(
                onPressed: () => _toast(context, 'Device contacts wiring later'),
                child: const Text('Import Device Contacts'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _toast(BuildContext context, String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }
}
