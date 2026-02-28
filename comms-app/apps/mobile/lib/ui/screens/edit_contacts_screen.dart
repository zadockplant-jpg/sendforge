import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/app_state.dart';
import '../../models/contact.dart';
import '../../services/api_client.dart';
import '../../services/contacts_api.dart';
import '../colors.dart';

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

  // Selection
  final Set<String> _selectedIds = {};
  int? _lastTappedIndex;
  bool _shiftDown = false;
  final FocusNode _keyboardFocus = FocusNode();

  // Editing
  String? _editingId;
  final TextEditingController _nameCtrl = TextEditingController();
  final TextEditingController _orgCtrl = TextEditingController();
  final TextEditingController _phoneCtrl = TextEditingController();
  final TextEditingController _emailCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _keyboardFocus.dispose();
    _nameCtrl.dispose();
    _orgCtrl.dispose();
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    super.dispose();
  }

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

  void _toggleSingle(Contact c) {
    setState(() {
      if (_selectedIds.contains(c.id)) {
        _selectedIds.remove(c.id);
      } else {
        _selectedIds.add(c.id);
      }
    });
  }

  void _toggleRange(List<Contact> items, int a, int b, bool select) {
    final start = a < b ? a : b;
    final end = a < b ? b : a;

    setState(() {
      for (int i = start; i <= end && i < items.length; i++) {
        final id = items[i].id;
        if (select) {
          _selectedIds.add(id);
        } else {
          _selectedIds.remove(id);
        }
      }
    });
  }

  void _startEditing(Contact c) {
    setState(() {
      _editingId = c.id;
      _nameCtrl.text = c.name;
      _orgCtrl.text = c.organization ?? "";
      _phoneCtrl.text = c.phone ?? "";
      _emailCtrl.text = c.email ?? "";
    });
  }

  void _stopEditing() {
    setState(() {
      _editingId = null;
    });
  }

  Future<void> _saveEditing(Contact c) async {
    final api = ApiClient(baseUrl: widget.appState.baseUrl);
    final contactsApi = ContactsApi(api);

    setState(() => _busy = true);

    try {
      await contactsApi.updateContact(
        c.id,
        name: _nameCtrl.text.trim(),
        organization: _orgCtrl.text.trim().isEmpty ? null : _orgCtrl.text.trim(),
        phone: _phoneCtrl.text.trim().isEmpty ? null : _phoneCtrl.text.trim(),
        email: _emailCtrl.text.trim().isEmpty ? null : _emailCtrl.text.trim(),
      );

      await widget.appState.loadContacts();
      _stopEditing();

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Contact updated ✅")),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Update failed: $e")),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _deleteSelected() async {
    if (_selectedIds.isEmpty) return;

    final ok = await showDialog<bool>(
          context: context,
          builder: (_) => AlertDialog(
            title: const Text("Delete contacts?"),
            content: Text(
              "This will HARD delete ${_selectedIds.length} contact(s).",
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text("Cancel"),
              ),
              ElevatedButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text("Delete"),
              ),
            ],
          ),
        ) ??
        false;

    if (!ok) return;

    final api = ApiClient(baseUrl: widget.appState.baseUrl);
    final contactsApi = ContactsApi(api);

    setState(() => _busy = true);

    try {
      for (final id in _selectedIds.toList()) {
        await contactsApi.deleteContact(id);
      }

      _selectedIds.clear();
      await widget.appState.loadContacts();

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Deleted ✅")),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Delete failed: $e")),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _avatar(Contact c) {
    final initial = c.name.trim().isEmpty ? "?" : c.name.trim()[0].toUpperCase();
    return CircleAvatar(
      radius: 18,
      child: Text(initial, style: const TextStyle(fontWeight: FontWeight.bold)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final items = _filtered;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Edit Contacts'),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: "Delete selected",
            onPressed: (_busy || _selectedIds.isEmpty) ? null : _deleteSelected,
            icon: const Icon(Icons.delete_outline),
          ),
          IconButton(
            tooltip: "Refresh",
            onPressed: _busy ? null : _refresh,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: RawKeyboardListener(
        focusNode: _keyboardFocus,
        autofocus: true,
        onKey: (evt) {
          if (!kIsWeb) return;
          final down = evt is RawKeyDownEvent;
          if (!down) return;
          setState(() {
            _shiftDown = evt.isShiftPressed;
          });
        },
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
                child: TextField(
                  decoration: const InputDecoration(
                    prefixIcon: Icon(Icons.search),
                    hintText: "Search contacts…",
                    isDense: true,
                  ),
                  onChanged: (v) => setState(() => _query = v),
                ),
              ),
              if (_err != null)
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(_err!, style: const TextStyle(color: Colors.red)),
                ),
              Expanded(
                child: _busy && widget.appState.contacts.isEmpty
                    ? const Center(child: CircularProgressIndicator())
                    : ListView.builder(
                        itemCount: items.length,
                        itemBuilder: (_, i) {
                          final c = items[i];
                          final selected = _selectedIds.contains(c.id);
                          final isEditing = _editingId == c.id;

                          return InkWell(
                            onTap: () {
                              // Shift-click selection range (desktop/web)
                              if (kIsWeb && _shiftDown && _lastTappedIndex != null) {
                                final anchor = _lastTappedIndex!;
                                final wantSelect = !_selectedIds.contains(c.id);
                                _toggleRange(items, anchor, i, wantSelect);
                              } else {
                                // Tap opens inline editor (requested behavior)
                                _startEditing(c);
                              }
                              _lastTappedIndex = i;
                            },
                            onLongPress: () {
                              // Long press toggles selection (mobile)
                              _toggleSingle(c);
                              _lastTappedIndex = i;
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                              decoration: BoxDecoration(
                                color: selected ? Colors.blue.withOpacity(0.08) : null,
                                border: Border(
                                  bottom: BorderSide(color: Colors.black.withOpacity(0.06)),
                                ),
                              ),
                              child: Column(
                                children: [
                                  Row(
                                    crossAxisAlignment: CrossAxisAlignment.center,
                                    children: [
                                      Checkbox(
                                        value: selected,
                                        onChanged: (_) => _toggleSingle(c),
                                      ),
                                      _avatar(c),
                                      const SizedBox(width: 10),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              c.name,
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: const TextStyle(fontWeight: FontWeight.w700),
                                            ),
                                            const SizedBox(height: 2),
                                            Row(
                                              children: [
                                                if ((c.organization ?? "").isNotEmpty)
                                                  Flexible(
                                                    child: Text(
                                                      c.organization!,
                                                      maxLines: 1,
                                                      overflow: TextOverflow.ellipsis,
                                                      style: const TextStyle(
                                                        fontSize: 12,
                                                        color: Colors.blueGrey,
                                                      ),
                                                    ),
                                                  ),
                                                if ((c.organization ?? "").isNotEmpty) const SizedBox(width: 8),
                                                if (c.hasSms)
                                                  Container(
                                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                                    decoration: BoxDecoration(
                                                      borderRadius: BorderRadius.circular(999),
                                                      border: Border.all(color: Colors.black.withOpacity(0.15)),
                                                    ),
                                                    child: const Text("SMS", style: TextStyle(fontSize: 11)),
                                                  ),
                                                if (c.hasSms && c.hasEmail) const SizedBox(width: 6),
                                                if (c.hasEmail)
                                                  Container(
                                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                                    decoration: BoxDecoration(
                                                      borderRadius: BorderRadius.circular(999),
                                                      border: Border.all(color: Colors.black.withOpacity(0.15)),
                                                    ),
                                                    child: const Text("Email", style: TextStyle(fontSize: 11)),
                                                  ),
                                              ],
                                            ),
                                          ],
                                        ),
                                      ),
                                      IconButton(
                                        tooltip: isEditing ? "Close" : "Edit",
                                        onPressed: () => isEditing ? _stopEditing() : _startEditing(c),
                                        icon: Icon(isEditing ? Icons.close : Icons.edit_outlined),
                                      ),
                                    ],
                                  ),

                                  if (isEditing) ...[
                                    const SizedBox(height: 10),
                                    Row(
                                      children: [
                                        Expanded(
                                          child: TextField(
                                            controller: _nameCtrl,
                                            decoration: const InputDecoration(
                                              labelText: "Name",
                                              isDense: true,
                                            ),
                                          ),
                                        ),
                                        const SizedBox(width: 10),
                                        Expanded(
                                          child: TextField(
                                            controller: _orgCtrl,
                                            decoration: const InputDecoration(
                                              labelText: "Org",
                                              isDense: true,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 10),
                                    Row(
                                      children: [
                                        Expanded(
                                          child: TextField(
                                            controller: _phoneCtrl,
                                            decoration: const InputDecoration(
                                              labelText: "Phone",
                                              isDense: true,
                                            ),
                                          ),
                                        ),
                                        const SizedBox(width: 10),
                                        Expanded(
                                          child: TextField(
                                            controller: _emailCtrl,
                                            decoration: const InputDecoration(
                                              labelText: "Email",
                                              isDense: true,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 10),
                                    Row(
                                      children: [
                                        Expanded(
                                          child: FilledButton.icon(
                                            onPressed: _busy ? null : () => _saveEditing(c),
                                            icon: const Icon(Icons.save_outlined),
                                            label: const Text("Save"),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ],
                              ),
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