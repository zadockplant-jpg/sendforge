import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/contact.dart';
import '../../services/api_client.dart';
import '../colors.dart';
import '../../services/contacts_api.dart';

class EditContactsScreen extends StatefulWidget {
  final AppState appState;
  const EditContactsScreen({super.key, required this.appState});

  @override
  State<EditContactsScreen> createState() => _EditContactsScreenState();
}

class _EditContactsScreenState extends State<EditContactsScreen> {
  bool _busy = false;
  String? _err;
  String _query = "";

  Future<void> _refresh() async {
    setState(() {
      _busy = true;
      _err = null;
    });

    try {
      await widget.appState.loadContacts();
    } catch (e) {
      _err = e.toString();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  List<Contact> get _filtered {
    final q = _query.toLowerCase().trim();
    final list = widget.appState.contacts.toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));

    if (q.isEmpty) return list;

    return list.where((c) {
      return c.name.toLowerCase().contains(q) ||
          (c.organization ?? "").toLowerCase().contains(q) ||
          (c.phone ?? "").toLowerCase().contains(q) ||
          (c.email ?? "").toLowerCase().contains(q);
    }).toList();
  }

  Future<void> _delete(Contact c) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text("Delete contact?"),
        content: Text("This permanently deletes:\n\n${c.name}\n\nThis cannot be undone."),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text("Cancel")),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text("Delete")),
        ],
      ),
    );

    if (ok != true) return;

    setState(() {
      _busy = true;
      _err = null;
    });

    try {
      final client = ApiClient(baseUrl: widget.appState.baseUrl);
      final api = ContactsApi(client);

      await api.deleteContact(c.id);

      await widget.appState.loadContacts();
    } catch (e) {
      _err = e.toString();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _filtered;

    return Scaffold(
      appBar: AppBar(
        title: const Text("Edit Contacts"),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              TextField(
                decoration: InputDecoration(
                  hintText: "Search contacts",
                  prefixIcon: const Icon(Icons.search),
                  isDense: true,
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                ),
                onChanged: (v) => setState(() => _query = v),
              ),
              const SizedBox(height: 10),
              if (_err != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Text(_err!, style: const TextStyle(color: Colors.red)),
                ),
              Expanded(
                child: _busy
                    ? const Center(child: CircularProgressIndicator())
                    : ListView.builder(
                        itemCount: items.length,
                        itemBuilder: (context, i) {
                          final c = items[i];
                          return Container(
                            height: 60,
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        c.name,
                                        style: const TextStyle(fontWeight: FontWeight.w800),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        [
                                          if ((c.organization ?? "").trim().isNotEmpty) c.organization!.trim(),
                                          if ((c.phone ?? "").trim().isNotEmpty) "SMS",
                                          if ((c.email ?? "").trim().isNotEmpty) "Email",
                                        ].join(" • "),
                                        style: TextStyle(
                                          fontSize: 12,
                                          color: Colors.black.withOpacity(0.6),
                                          fontWeight: FontWeight.w600,
                                        ),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ],
                                  ),
                                ),
                                IconButton(
                                  tooltip: "Delete",
                                  icon: const Icon(Icons.delete_outline),
                                  onPressed: () => _delete(c),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}