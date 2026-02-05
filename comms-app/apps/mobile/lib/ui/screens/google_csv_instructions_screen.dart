import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../colors.dart';
import '../components/sf_card.dart';
import 'contacts_import_screen.dart';

class GoogleCsvInstructionsScreen extends StatelessWidget {
  final AppState appState;
  const GoogleCsvInstructionsScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Google → CSV'),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: SFCard(
          title: 'Export Google Contacts as CSV',
          subtitle: 'OAuth import is deferred per “the list”. This is the working path now.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Steps:\n'
                '1) On your computer, open Google Contacts.\n'
                '2) Click Export.\n'
                '3) Choose "Google CSV" or "Outlook CSV".\n'
                '4) Save the .csv file.\n'
                '5) Back in SendForge, tap Import CSV and pick the file.\n',
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => ContactsImportScreen(appState: appState),
                      ),
                    );
                  },
                  child: const Text('Continue to CSV import'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
