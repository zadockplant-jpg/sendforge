import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../components/sf_card.dart';

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
          children: [
            SFCard(
              title: 'Import from Google',
              subtitle: 'Sync contacts from Google account',
              child: ElevatedButton(
                onPressed: () {},
                child: const Text('Connect Google'),
              ),
            ),
            const SizedBox(height: 12),

            SFCard(
              title: 'Import CSV',
              subtitle: 'Upload a CSV file',
              child: ElevatedButton(
                onPressed: () {},
                child: const Text('Upload CSV'),
              ),
            ),
            const SizedBox(height: 12),

            SFCard(
              title: 'Import Device Contacts',
              subtitle: 'Use phone contact list',
              child: ElevatedButton(
                onPressed: () {},
                child: const Text('Select Contacts'),
              ),
            ),
            const SizedBox(height: 12),

            SFCard(
              title: 'Add Contact',
              subtitle: 'Enter contact manually',
              child: ElevatedButton(
                onPressed: () {},
                child: const Text('Add Contact'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
