import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../../models/contact.dart';
import '../../services/api_client.dart';
import '../../services/contact_import_service.dart';
import '../../services/csv_parser.dart';
import '../colors.dart';
import '../components/sf_card.dart';

class ContactsImportScreen extends StatefulWidget {
  final AppState appState;
  const ContactsImportScreen({super.key, required this.appState});

  @override
  State<ContactsImportScreen> createState() => _ContactsImportScreenState();
}

class _ContactsImportScreenState extends State<ContactsImportScreen> {
  List<Contact> _parsed = [];
  bool _busy = false;
  String? _status;

  Future<void> _pickCsv() async {
    setState(() {
      _status = null;
      _busy = true;
      _parsed = [];
    });

    try {
      final contacts = await CsvParser.pickAndParseCsv();
      setState(() {
        _parsed = contacts;
        _status = contacts.isEmpty
            ? 'No contacts found in that CSV.'
            : 'Parsed ${contacts.length} contacts. Review then import.';
      });
    } catch (e) {
      setState(() => _status = 'Error parsing CSV: $e');
    } finally {
      setState(() => _busy = false);
    }
  }

  Future<void> _import() async {
    if (_parsed.isEmpty) {
      setState(() => _status = 'Pick a CSV first.');
      return;
    }

    setState(() {
      _status = null;
      _busy = true;
    });

    try {
      final api = ApiClient(baseUrl: widget.appState.baseUrl);
      final svc = ContactImportService(api);

      final resp = await svc.importContacts(
        method: 'csv',
        contacts: _parsed,
      );

      // Update local state so UI can use contacts immediately
      widget.appState.contacts.addAll(_parsed);
      widget.appState.notifyListeners();

      final added = resp['added']?.toString() ?? '?';
      final dupes = resp['duplicates']?.toString() ?? '?';
      final invalid = resp['invalid']?.toString() ?? '?';

      setState(() {
        _status = 'Imported ✅  added=$added  duplicates=$dupes  invalid=$invalid';
      });

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Contacts imported successfully')),
      );
    } catch (e) {
      setState(() => _status = 'Import failed: $e');
    } finally {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final preview = _parsed.take(12).toList();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Import CSV'),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            SFCard(
              title: 'Step 1 — Pick a CSV',
              subtitle: 'We parse it locally first, then import to your backend.',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FilledButton(
                    onPressed: _busy ? null : _pickCsv,
                    child: Text(_busy ? 'Working…' : 'Pick CSV'),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    _parsed.isEmpty
                        ? 'No file selected yet.'
                        : '${_parsed.length} contact(s) parsed.',
                    style: const TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            SFCard(
              title: 'Step 2 — Preview',
              subtitle: preview.isEmpty ? 'Pick a CSV to preview contacts.' : 'Showing first ${preview.length} items.',
              child: preview.isEmpty
                  ? const Text('—')
                  : Column(
                      children: preview.map((c) {
                        final line = [
                          c.name,
                          if ((c.phone ?? '').isNotEmpty) c.phone!,
                          if ((c.email ?? '').isNotEmpty) c.email!,
                        ].join(' • ');
                        return ListTile(
                          dense: true,
                          title: Text(
                            line,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        );
                      }).toList(),
                    ),
            ),
            const SizedBox(height: 12),
            SFCard(
              title: 'Step 3 — Import to SendForge',
              subtitle: 'This calls POST /v1/contacts/import (Render or local backend).',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FilledButton(
                    onPressed: _busy ? null : _import,
                    child: Text(_busy ? 'Importing…' : 'Import to SendForge'),
                  ),
                  if (_status != null) ...[
                    const SizedBox(height: 10),
                    Text(
                      _status!,
                      style: TextStyle(
                        fontSize: 12,
                        color: _status!.toLowerCase().contains('fail') ||
                                _status!.toLowerCase().contains('error')
                            ? Colors.redAccent
                            : SFColors.textPrimary,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
