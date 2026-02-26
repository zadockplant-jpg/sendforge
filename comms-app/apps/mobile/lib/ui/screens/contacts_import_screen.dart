import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/contact.dart';
import '../../services/api_client.dart';
import '../../services/contact_import_service.dart';
import '../colors.dart';

class ImportContactsScreen extends StatefulWidget {
  final AppState appState;
  const ImportContactsScreen({super.key, required this.appState});

  @override
  State<ImportContactsScreen> createState() => _ImportContactsScreenState();
}

class _ImportContactsScreenState extends State<ImportContactsScreen> {
  List<Contact> preview = [];
  bool busy = false;
  String? err;

  int tab = 0; // 0 import, 1 manage

  late final ApiClient api;
  late final ContactImportService svc;

  @override
  void initState() {
    super.initState();
    api = ApiClient(baseUrl: widget.appState.baseUrl);
    svc = ContactImportService(api, widget.appState);

    widget.appState.loadContacts();
  }

  Future<void> _importNow() async {
    setState(() {
      busy = true;
      err = null;
    });

    try {
      await svc.importContacts(method: "manual", contacts: preview);
      setState(() => preview = []);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Imported.")),
        );
      }
    } catch (e) {
      setState(() => err = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _deleteContact(String id) async {
    setState(() {
      busy = true;
      err = null;
    });

    try {
      await svc.deleteContact(id);
    } catch (e) {
      setState(() => err = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Contacts"),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (err != null)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(err!, style: const TextStyle(color: Colors.red)),
              ),

            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
              child: Row(
                children: [
                  Expanded(
                    child: SegmentedButton<int>(
                      segments: const [
                        ButtonSegment(value: 0, label: Text("Import")),
                        ButtonSegment(value: 1, label: Text("Manage")),
                      ],
                      selected: {tab},
                      onSelectionChanged: (s) => setState(() => tab = s.first),
                    ),
                  ),
                ],
              ),
            ),

            if (busy) const LinearProgressIndicator(),

            Expanded(
              child: tab == 0 ? _buildImport() : _buildManage(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildImport() {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          const Align(
            alignment: Alignment.centerLeft,
            child: Text(
              "Quick add (manual preview)",
              style: TextStyle(fontWeight: FontWeight.w900),
            ),
          ),
          const SizedBox(height: 10),

          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      final c = await showDialog<Contact>(
                        context: context,
                        builder: (_) => const _AddContactDialog(),
                      );
                      if (c != null) setState(() => preview.add(c));
                    },
              child: const Text("Add to preview"),
            ),
          ),

          const SizedBox(height: 10),

          Expanded(
            child: preview.isEmpty
                ? const Center(child: Text("No preview contacts yet."))
                : ListView.separated(
                    itemCount: preview.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 6),
                    itemBuilder: (_, i) {
                      final c = preview[i];
                      return Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: Colors.black.withOpacity(0.06)),
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                c.name,
                                style: const TextStyle(fontWeight: FontWeight.w800),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            IconButton(
                              onPressed: busy ? null : () => setState(() => preview.removeAt(i)),
                              icon: const Icon(Icons.close),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
          ),

          const SizedBox(height: 10),

          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: busy || preview.isEmpty ? null : _importNow,
              child: const Text("Import now"),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildManage() {
    final contacts = widget.appState.contacts;

    if (contacts.isEmpty) {
      return const Center(child: Text("No contacts yet."));
    }

    return RefreshIndicator(
      onRefresh: widget.appState.loadContacts,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 14),
        itemCount: contacts.length,
        separatorBuilder: (_, __) => const SizedBox(height: 6),
        itemBuilder: (_, i) {
          final c = contacts[i];
          final org = (c.organization ?? '').trim();

          return Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: Colors.black.withOpacity(0.06)),
            ),
            child: ListTile(
              dense: true,
              title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w800)),
              subtitle: Text(
                [
                  if (org.isNotEmpty) org,
                  if ((c.phone ?? '').trim().isNotEmpty) c.phone!,
                  if ((c.email ?? '').trim().isNotEmpty) c.email!,
                ].join(" • "),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              trailing: IconButton(
                icon: const Icon(Icons.delete_outline),
                onPressed: busy
                    ? null
                    : () async {
                        final ok = await showDialog<bool>(
                          context: context,
                          builder: (_) => AlertDialog(
                            title: const Text("Delete contact?"),
                            content: Text("Delete ${c.name}?"),
                            actions: [
                              TextButton(onPressed: () => Navigator.pop(context, false), child: const Text("Cancel")),
                              FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text("Delete")),
                            ],
                          ),
                        );
                        if (ok == true) {
                          await _deleteContact(c.id);
                        }
                      },
              ),
            ),
          );
        },
      ),
    );
  }
}

class _AddContactDialog extends StatefulWidget {
  const _AddContactDialog();

  @override
  State<_AddContactDialog> createState() => _AddContactDialogState();
}

class _AddContactDialogState extends State<_AddContactDialog> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  final _org = TextEditingController();

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text("Add Contact"),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(controller: _name, decoration: const InputDecoration(labelText: "Name")),
          TextField(controller: _org, decoration: const InputDecoration(labelText: "Organization")),
          TextField(controller: _phone, decoration: const InputDecoration(labelText: "Phone")),
          TextField(controller: _email, decoration: const InputDecoration(labelText: "Email")),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text("Cancel")),
        FilledButton(
          onPressed: () {
            final name = _name.text.trim();
            if (name.isEmpty) return;

            Navigator.pop(
              context,
              Contact(
                id: "",
                name: name,
                phone: _phone.text.trim().isEmpty ? null : _phone.text.trim(),
                email: _email.text.trim().isEmpty ? null : _email.text.trim(),
                organization: _org.text.trim().isEmpty ? null : _org.text.trim(),
              ),
            );
          },
          child: const Text("Add"),
        ),
      ],
    );
  }
}