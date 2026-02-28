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

  // Mobile drag selection
  bool _mobileDragMode = false;
  int? _mobileDragAnchorIndex;
  int? _mobileDragLastIndex;
  double _scrollOffset = 0;

  static const double _rowHeight = 64.0;

  // Inline editing
  String? _editingId;
  final TextEditingController _nameCtrl = TextEditingController();
  final TextEditingController _orgCtrl = TextEditingController();
  final TextEditingController _phoneCtrl = TextEditingController();
  final TextEditingController _emailCtrl = TextEditingController();

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

  @override
  void dispose() {
    _keyboardFocus.dispose();
    _nameCtrl.dispose();
    _orgCtrl.dispose();
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    super.dispose();
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

  int _indexFromLocalDy(double dy) {
    final absolute = dy + _scrollOffset;
    final i = (absolute / _rowHeight).floor();
    return i < 0 ? 0 : i;
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
      for (int i = start; i <= end; i++) {
        final id = items[i].id;
        if (select) {
          _selectedIds.add(id);
        } else {
          _selectedIds.remove(id);
        }
      }
    });
  }

  void _startEdit(Contact c) {
    setState(() {
      _editingId = c.id;
      _nameCtrl.text = c.name;
      _orgCtrl.text = (c.organization ?? "");
      _phoneCtrl.text = (c.phone ?? "");
      _emailCtrl.text = (c.email ?? "");
    });
  }

  void _cancelEdit() {
    setState(() {
      _editingId = null;
      _nameCtrl.clear();
      _orgCtrl.clear();
      _phoneCtrl.clear();
      _emailCtrl.clear();
    });
  }

  Future<void> _saveEdit(Contact original) async {
    // NOTE: backend update endpoint is not in this export set.
    // We do not invent wiring that might not exist.
    // We update AppState list locally so UI reflects edit, without breaking existing flows.
    final updated = Contact(
      id: original.id,
      name: _nameCtrl.text.trim().isEmpty ? original.name : _nameCtrl.text.trim(),
      phone: _phoneCtrl.text.trim().isEmpty ? null : _phoneCtrl.text.trim(),
      email: _emailCtrl.text.trim().isEmpty ? null : _emailCtrl.text.trim(),
      organization: _orgCtrl.text.trim().isEmpty ? null : _orgCtrl.text.trim(),
    );

    setState(() {
      final idx = widget.appState.contacts.indexWhere((c) => c.id == original.id);
      if (idx >= 0) {
        widget.appState.contacts[idx] = updated;
      }
      _editingId = null;
    });

    // If/when we add PUT /v1/contacts/:id + client method, we’ll wire it here.
    // This preserves stability and prevents regressions today.
  }

  Future<void> _deleteSelected(List<Contact> items) async {
    if (_selectedIds.isEmpty) return;

    final count = _selectedIds.length;

    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text("Delete contacts?"),
        content: Text("This permanently deletes $count contact(s).\n\nThis cannot be undone."),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text("Cancel"),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text("Delete"),
          ),
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

      // delete sequential (stable, simple)
      for (final id in _selectedIds.toList()) {
        await api.deleteContact(id);
      }

      _selectedIds.clear();
      await widget.appState.loadContacts();
    } catch (e) {
      _err = e.toString();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _avatar(Contact c) {
    final initials = c.name.trim().isEmpty ? "?" : c.name.trim().split(RegExp(r"\s+")).take(2).map((p) => p.substring(0, 1).toUpperCase()).join();
    return Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(
        color: Colors.black.withOpacity(0.06),
        borderRadius: BorderRadius.circular(10),
      ),
      alignment: Alignment.center,
      child: Text(initials, style: const TextStyle(fontWeight: FontWeight.w800)),
    );
  }

  Widget _chips(Contact c) {
    final hasSms = (c.phone ?? "").trim().isNotEmpty;
    final hasEmail = (c.email ?? "").trim().isNotEmpty;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (hasSms) _chip("SMS"),
        if (hasEmail) _chip("Email"),
      ],
    );
  }

  Widget _chip(String label) {
    return Padding(
      padding: const EdgeInsets.only(left: 6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: Colors.black.withOpacity(0.06),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(label, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final items = _filtered;

    return Scaffold(
      appBar: AppBar(
        title: const Text("Edit Contacts"),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
        actions: [
          if (_selectedIds.isNotEmpty)
            IconButton(
              tooltip: "Delete selected",
              icon: const Icon(Icons.delete_outline),
              onPressed: _busy ? null : () => _deleteSelected(items),
            ),
        ],
      ),
      body: RawKeyboardListener(
        focusNode: _keyboardFocus,
        autofocus: true,
        onKey: (evt) {
          final isShift = evt.logicalKey == LogicalKeyboardKey.shiftLeft ||
              evt.logicalKey == LogicalKeyboardKey.shiftRight;
          if (isShift) {
            setState(() {
              _shiftDown = evt is RawKeyDownEvent;
            });
          }
        },
        child: SafeArea(
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
                if (_mobileDragMode)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      children: [
                        const Icon(Icons.swipe, size: 18),
                        const SizedBox(width: 8),
                        const Expanded(
                          child: Text(
                            "Range select: hold + slide. Release to finish.",
                            style: TextStyle(fontSize: 12),
                          ),
                        ),
                        TextButton(
                          onPressed: () => setState(() {
                            _mobileDragMode = false;
                            _mobileDragAnchorIndex = null;
                            _mobileDragLastIndex = null;
                          }),
                          child: const Text("Cancel"),
                        ),
                      ],
                    ),
                  ),
                Expanded(
                  child: _busy
                      ? const Center(child: CircularProgressIndicator())
                      : NotificationListener<ScrollNotification>(
                          onNotification: (n) {
                            if (n.metrics.axis == Axis.vertical) _scrollOffset = n.metrics.pixels;
                            return false;
                          },
                          child: GestureDetector(
                            onLongPressStart: (d) {
                              if (kIsWeb) return;
                              if (items.isEmpty) return;
                              setState(() {
                                _mobileDragMode = true;
                                _mobileDragAnchorIndex = _indexFromLocalDy(d.localPosition.dy).clamp(0, items.length - 1);
                                _mobileDragLastIndex = _mobileDragAnchorIndex;
                              });
                            },
                            onLongPressMoveUpdate: (d) {
                              if (!_mobileDragMode) return;
                              if (items.isEmpty) return;
                              final idx = _indexFromLocalDy(d.localPosition.dy).clamp(0, items.length - 1);
                              if (idx == _mobileDragLastIndex) return;

                              final anchor = (_mobileDragAnchorIndex ?? idx).clamp(0, items.length - 1);
                              _toggleRange(items, anchor, idx, true);
                              setState(() => _mobileDragLastIndex = idx);
                            },
                            onLongPressEnd: (_) {
                              if (!_mobileDragMode) return;
                              setState(() {
                                _mobileDragMode = false;
                                _mobileDragAnchorIndex = null;
                                _mobileDragLastIndex = null;
                              });
                            },
                            child: ListView.builder(
                              itemExtent: _rowHeight,
                              itemCount: items.length,
                              itemBuilder: (context, i) {
                                final c = items[i];
                                final selected = _selectedIds.contains(c.id);
                                final isEditing = _editingId == c.id;

                                return InkWell(
                                  onTap: () {
                                    // If editing, keep tap behavior minimal
                                    if (_editingId != null && _editingId != c.id) return;

                                    final canShiftRange =
                                        (kIsWeb ||
                                            defaultTargetPlatform == TargetPlatform.windows ||
                                            defaultTargetPlatform == TargetPlatform.macOS ||
                                            defaultTargetPlatform == TargetPlatform.linux) &&
                                        _shiftDown;

                                    if (canShiftRange && _lastTappedIndex != null) {
                                      final select = !selected;
                                      _toggleRange(items, _lastTappedIndex!, i, select);
                                    } else {
                                      _toggleSingle(c);
                                    }
                                    _lastTappedIndex = i;
                                  },
                                  onLongPress: () {
                                    if (kIsWeb) return;
                                    _toggleSingle(c);
                                  },
                                  child: Container(
                                    height: _rowHeight,
                                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                    color: selected ? Colors.blue.withOpacity(0.08) : null,
                                    child: Row(
                                      children: [
                                        _avatar(c),
                                        const SizedBox(width: 10),
                                        Expanded(
                                          child: isEditing
                                              ? Column(
                                                  mainAxisAlignment: MainAxisAlignment.center,
                                                  children: [
                                                    Row(
                                                      children: [
                                                        Expanded(
                                                          child: TextField(
                                                            controller: _nameCtrl,
                                                            decoration: const InputDecoration(
                                                              isDense: true,
                                                              hintText: "Name",
                                                              border: OutlineInputBorder(),
                                                            ),
                                                          ),
                                                        ),
                                                        const SizedBox(width: 8),
                                                        IconButton(
                                                          tooltip: "Save",
                                                          onPressed: () => _saveEdit(c),
                                                          icon: const Icon(Icons.check_circle_outline),
                                                        ),
                                                        IconButton(
                                                          tooltip: "Cancel",
                                                          onPressed: _cancelEdit,
                                                          icon: const Icon(Icons.close),
                                                        ),
                                                      ],
                                                    ),
                                                    const SizedBox(height: 6),
                                                    Row(
                                                      children: [
                                                        Expanded(
                                                          child: TextField(
                                                            controller: _orgCtrl,
                                                            decoration: const InputDecoration(
                                                              isDense: true,
                                                              hintText: "Organization",
                                                              border: OutlineInputBorder(),
                                                            ),
                                                          ),
                                                        ),
                                                        const SizedBox(width: 8),
                                                        Expanded(
                                                          child: TextField(
                                                            controller: _phoneCtrl,
                                                            decoration: const InputDecoration(
                                                              isDense: true,
                                                              hintText: "Phone (SMS)",
                                                              border: OutlineInputBorder(),
                                                            ),
                                                          ),
                                                        ),
                                                        const SizedBox(width: 8),
                                                        Expanded(
                                                          child: TextField(
                                                            controller: _emailCtrl,
                                                            decoration: const InputDecoration(
                                                              isDense: true,
                                                              hintText: "Email",
                                                              border: OutlineInputBorder(),
                                                            ),
                                                          ),
                                                        ),
                                                      ],
                                                    ),
                                                  ],
                                                )
                                              : Column(
                                                  mainAxisAlignment: MainAxisAlignment.center,
                                                  crossAxisAlignment: CrossAxisAlignment.start,
                                                  children: [
                                                    Row(
                                                      children: [
                                                        Expanded(
                                                          child: Text(
                                                            c.name,
                                                            style: const TextStyle(fontWeight: FontWeight.w800),
                                                            overflow: TextOverflow.ellipsis,
                                                          ),
                                                        ),
                                                        if ((c.organization ?? "").trim().isNotEmpty)
                                                          Expanded(
                                                            child: Text(
                                                              c.organization!.trim(),
                                                              textAlign: TextAlign.right,
                                                              style: TextStyle(
                                                                fontSize: 12,
                                                                color: Colors.blueGrey.withOpacity(0.9),
                                                                fontWeight: FontWeight.w600,
                                                              ),
                                                              overflow: TextOverflow.ellipsis,
                                                            ),
                                                          ),
                                                      ],
                                                    ),
                                                    const SizedBox(height: 4),
                                                    Row(
                                                      children: [
                                                        _chips(c),
                                                        const Spacer(),
                                                        TextButton(
                                                          onPressed: () => _startEdit(c),
                                                          child: const Text("Edit"),
                                                        ),
                                                      ],
                                                    ),
                                                  ],
                                                ),
                                        ),
                                        Checkbox(
                                          value: selected,
                                          onChanged: (_) => _toggleSingle(c),
                                          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                          visualDensity: const VisualDensity(horizontal: -3, vertical: -3),
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                              },
                            ),
                          ),
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}