import 'package:flutter/material.dart';
import '../../services/contact_import_service.dart';

class ImportContactsScreen extends StatelessWidget {
  const ImportContactsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final contacts = ContactImportService.mock();

    return Scaffold(
      appBar: AppBar(title: const Text("Import Contacts")),
      body: ListView(
        children: contacts.map((c) {
          return ListTile(
            title: Text(c.name),
            subtitle: Text(c.phone ?? c.email ?? ""),
            trailing: Icon(Icons.add),
          );
        }).toList(),
      ),
    );
  }
}
