import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/contact.dart';
import '../../services/api_client.dart';
import '../../services/contact_import_service.dart';
import '../../services/csv_parser.dart';

class CsvImportScreen extends StatefulWidget {
  final AppState appState;
  const CsvImportScreen({super.key, required this.appState});

  @override
  State<CsvImportScreen> createState() => _CsvImportScreenState();
}

class _CsvImportScreenState extends State<CsvImportScreen> {
  bool busy = false;
  String? status;
  List<Contact> parsed = [];

  Future<void> _pickParse() async {
    setState(() {
      busy = true;
      status = null;
      parsed = [];
    });

    try {
      final contacts = await CsvParser.pickAndParseCsv();
      if (!mounted) return;

      setState(() {
        parsed = contacts;
        status = contacts.isEmpty
            ? 'No contacts found in CSV.'
            : 'Parsed ${contacts.length} contacts. Ready to import.';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => status = 'Error parsing CSV: $e');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _import() async {
    if (parsed.isEmpty) {
      setState(() => status = 'Pick a CSV first.');
      return;
    }

    setState(() {
      busy = true;
      status = null;
    });

    try {
      final api = ApiClient(baseUrl: widget.appState.baseUrl);
      final service = ContactImportService(api, widget.appState);


      final result = await service.importContacts(
        method: 'csv',
        contacts: parsed,
      );

      // Update local state (lightweight, no schema changes)
      // De-dupe locally by id (best effort)
      final existingIds = widget.appState.contacts.map((c) => c.id).toSet();
      for (final c in parsed) {
        if (!existingIds.contains(c.id)) widget.appState.contacts.add(c);
      }

      if (!mounted) return;
      setState(() {
        status =
            'Imported ✅  Added: ${result['added'] ?? result['inserted'] ?? parsed.length}  Duplicates: ${result['duplicates'] ?? 0}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => status = 'Import failed: $e');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Import CSV')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: busy ? null : _pickParse,
                style: FilledButton.styleFrom(
                  alignment: Alignment.centerLeft,
                  padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
                ),
                child: Text(
                  busy ? 'Working…' : 'Select CSV File',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
            ),
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: busy || parsed.isEmpty ? null : _import,
                style: FilledButton.styleFrom(
                  alignment: Alignment.centerLeft,
                  padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
                ),
                child: const Text(
                  'Import Now',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
            ),
            const SizedBox(height: 16),
            if (status != null) Text(status!),
            const SizedBox(height: 12),
            if (parsed.isNotEmpty)
              Expanded(
                child: ListView.separated(
                  itemCount: parsed.length.clamp(0, 50),
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final c = parsed[i];
                    final sub = (c.phone ?? c.email ?? '').toString();
                    return ListTile(
                      title: Text(c.name),
                      subtitle: Text(sub),
                    );
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}
