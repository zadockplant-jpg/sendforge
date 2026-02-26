// comms-app/apps/mobile/lib/ui/screens/group_detail_screen.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../models/contact.dart';
import '../../services/groups_api.dart';
import '../components/compact_contact_tile.dart';
import '../colors.dart';

class GroupDetailScreen extends StatefulWidget {
  final AppState appState;
  final Group group;

  const GroupDetailScreen({
    super.key,
    required this.appState,
    required this.group,
  });

  @override
  State<GroupDetailScreen> createState() => _GroupDetailScreenState();
}

class _GroupDetailScreenState extends State<GroupDetailScreen> {
  late Set<String> _selectedMemberIds;
  final TextEditingController _search = TextEditingController();
  bool _saving = false;

  // Range selection support
  int? _lastTappedIndex; // for desktop shift-select
  bool _shiftDown = false;
  final FocusNode _keyboardFocus = FocusNode();

  // Mobile range mode
  int? _mobileRangeAnchor;
  bool get _inMobileRangeMode => _mobileRangeAnchor != null;

  @override
  void initState() {
    super.initState();
    _selectedMemberIds = widget.group.members.map((m) => m.id).toSet();
  }

  @override
  void dispose() {
    _search.dispose();
    _keyboardFocus.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (widget.group.type == "meta") {
      // Meta group membership is dynamic; member editing happens via meta-link builder (next pass).
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Meta groups are dynamic. Edit linked groups instead.")),
      );
      return;
    }

    setState(() => _saving = true);

    try {
      final api = GroupsApi(widget.appState);
      final updated = await api.updateMembers(
        widget.group.id,
        _selectedMemberIds.toList(),
      );

      // ✅ Fix: update AppState immediately so memberCount updates without leaving screen
      widget.appState.upsertGroup(updated);

      if (!mounted) return;
      Navigator.pop(context);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Save failed: $e")),
      );
    }
  }

  void _toggleSingle(Contact c) {
    setState(() {
      if (_selectedMemberIds.contains(c.id)) {
        _selectedMemberIds.remove(c.id);
      } else {
        _selectedMemberIds.add(c.id);
      }
    });
  }

  void _toggleRange(List<Contact> contacts, int a, int b, bool select) {
    final start = a < b ? a : b;
    final end = a < b ? b : a;

    setState(() {
      for (int i = start; i <= end; i++) {
        final id = contacts[i].id;
        if (select) {
          _selectedMemberIds.add(id);
        } else {
          _selectedMemberIds.remove(id);
        }
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final allContacts = widget.appState.contacts;
    final query = _search.text.toLowerCase();

    final contacts = allContacts.where((c) {
      return c.name.toLowerCase().contains(query) ||
          (c.organization ?? '').toLowerCase().contains(query);
    }).toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));

    final header = AppBar(
      title: Text(widget.group.name),
      backgroundColor: SFColors.primaryBlue,
      foregroundColor: Colors.white,
    );

    return Scaffold(
      appBar: header,
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
        child: Column(
          children: [
            // Search + Save row (always up top)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _search,
                      decoration: InputDecoration(
                        hintText: "Search name or organization",
                        isDense: true,
                        filled: true,
                        fillColor: Colors.white,
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      onChanged: (_) => setState(() {}),
                    ),
                  ),
                  const SizedBox(width: 10),
                  FilledButton(
                    onPressed: _saving ? null : _save,
                    child: _saving
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text("Save", style: TextStyle(fontWeight: FontWeight.w800)),
                  ),
                ],
              ),
            ),

            if (_inMobileRangeMode)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                child: Row(
                  children: [
                    const Icon(Icons.select_all, size: 18),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        "Range select: tap another contact to select the range. Tap again to exit.",
                        style: TextStyle(fontSize: 12),
                      ),
                    ),
                    TextButton(
                      onPressed: () => setState(() => _mobileRangeAnchor = null),
                      child: const Text("Cancel"),
                    ),
                  ],
                ),
              ),

            Expanded(
              child: ListView.builder(
                itemCount: contacts.length,
                itemBuilder: (context, i) {
                  final c = contacts[i];
                  final selected = _selectedMemberIds.contains(c.id);

                  return CompactContactTile(
                    contact: c,
                    selected: selected,

                    // Tap on row toggles; range logic applies on desktop shift, or mobile anchor mode
                    onToggle: () {
                      // Desktop/web: Shift selects range
                      final canShiftRange = (kIsWeb || !defaultTargetPlatform.toString().contains("android")) && _shiftDown;

                      if (canShiftRange && _lastTappedIndex != null) {
                        final select = !selected; // make range match current action
                        _toggleRange(contacts, _lastTappedIndex!, i, select);
                      } else if (_inMobileRangeMode && _mobileRangeAnchor != null) {
                        final anchor = _mobileRangeAnchor!;
                        final select = true; // mobile spec: selecting a range (we can add deselect-range later)
                        _toggleRange(contacts, anchor, i, select);
                        _mobileRangeAnchor = null;
                      } else {
                        _toggleSingle(c);
                      }

                      _lastTappedIndex = i;
                    },

                    // Mobile: long press on name/row sets anchor
                    onLongPressRow: () {
                      setState(() {
                        _mobileRangeAnchor = i;
                        _lastTappedIndex = i;
                      });
                    },

                    // Org tap selects all in org (ONLY for current group)
                    onSelectOrganization: () {
                      final org = c.organization;
                      if (org == null || org.isEmpty) return;

                      final orgContacts = allContacts
                          .where((x) => x.organization == org)
                          .map((x) => x.id);

                      setState(() {
                        _selectedMemberIds.addAll(orgContacts);
                      });
                    },

                    // Org long press = deselect all in org
                    onDeselectOrganization: () {
                      final org = c.organization;
                      if (org == null || org.isEmpty) return;

                      final orgContacts = allContacts
                          .where((x) => x.organization == org)
                          .map((x) => x.id);

                      setState(() {
                        _selectedMemberIds.removeAll(orgContacts);
                      });
                    },
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