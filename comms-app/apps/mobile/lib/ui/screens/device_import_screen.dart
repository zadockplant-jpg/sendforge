import 'package:flutter/material.dart';
import 'package:flutter_contacts/flutter_contacts.dart';

import '../../core/app_state.dart';
import '../../models/contact.dart' as sf;
import '../../services/api_client.dart';
import '../../services/contact_import_service.dart';

class DeviceContactsImportScreen extends StatefulWidget {
  final AppState appState;
  const DeviceContactsImportScreen({super.key, required this.appState});

  @override
  State<DeviceContactsImportScreen> createState() => _DeviceContactsImportScreenState();
}

class _DeviceContactsImportScreenState extends State<DeviceContactsImportScreen> {
  bool busy = false;
  String? status;

  Future<void> _import() async {
    setState(() {
      busy = true;
      status = null;
    });

    try {
      final granted = await FlutterContacts.requestPermission();
      if (!granted) {
        setState(() => status = 'Permission denied.');
        return;
      }

      final deviceContacts = await FlutterContacts.getContacts(withProperties: true);
      if (deviceContacts.isEmpty) {
        setState(() => status = 'No device contacts found.');
        return;
      }

      final mapped = <sf.Contact>[];
      for (final c in deviceContacts) {
        final name = c.displayName.trim().isEmpty ? 'Unknown' : c.displayName.trim();

        String? phone;
        if (c.phones.isNotEmpty) {
          phone = c.phones.first.number.trim();
          if (phone.isEmpty) phone = null;
        }

        String? email;
        if (c.emails.isNotEmpty) {
          email = c.emails.first.address.trim();
          if (email.isEmpty) email = null;
        }

        if (phone == null && email == null) continue;

        mapped.add(
          sf.Contact(
            id: 'device_${c.id}',
            name: name,
            phone: phone,
            email: email,
          ),
        );
      }

      if (mapped.isEmpty) {
        setState(() => status = 'No usable device contacts (no phone/email).');
        return;
      }

      final api = ApiClient(baseUrl: widget.appState.baseUrl);
      final svc = ContactImportService(api, widget.appState);


      final resp = await svc.importContacts(method: 'device', contacts: mapped);

      setState(() {
        status = 'Imported ✅ (added: ${resp['added'] ?? mapped.length}, dup: ${resp['duplicates'] ?? 0})';
      });
    } catch (e) {
      setState(() => status = 'Error: $e');
    } finally {
      setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Import from Device')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: busy ? null : _import,
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(busy ? 'Importing…' : 'Import Device Contacts'),
                ),
              ),
            ),
            if (status != null) ...[
              const SizedBox(height: 12),
              Text(status!),
            ],
          ],
        ),
      ),
    );
  }
}
