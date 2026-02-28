import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../services/groups_api.dart';
import '../colors.dart';
import '../groups/avatar_picker_modal.dart';
import '../groups/group_avatar_atlas.dart';

class CreateGroupScreen extends StatefulWidget {
  final AppState appState;
  final String type; // "snapshot" or "meta"

  const CreateGroupScreen({
    super.key,
    required this.appState,
    required this.type,
  });

  @override
  State<CreateGroupScreen> createState() => _CreateGroupScreenState();
}

class _CreateGroupScreenState extends State<CreateGroupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();

  String? _selectedAvatar;

  bool _saving = false;
  String? _err;

  Future<void> _pickAvatar() async {
    await showDialog(
      context: context,
      builder: (_) => AvatarPickerModal(
        selected: _selectedAvatar,
        onSelected: (k) => setState(() => _selectedAvatar = k),
      ),
    );
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _saving = true;
      _err = null;
    });

    try {
      final groupsApi = GroupsApi(widget.appState);

      await groupsApi.create(
        name: _nameCtrl.text.trim(),
        type: widget.type,
        avatarKey: _selectedAvatar, // ✅ store avatarKey string only
      );

      await widget.appState.loadGroups();

      if (mounted) Navigator.pop(context);
    } catch (e) {
      setState(() => _err = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isMeta = widget.type == "meta";

    return Scaffold(
      appBar: AppBar(
        title: Text(isMeta ? "Create Meta Group" : "Create Group"),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (_err != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(
                      _err!,
                      style: const TextStyle(color: Colors.red),
                    ),
                  ),
                Form(
                  key: _formKey,
                  child: TextFormField(
                    controller: _nameCtrl,
                    decoration: const InputDecoration(
                      labelText: "Group Name",
                    ),
                    validator: (v) => (v == null || v.trim().isEmpty)
                        ? "Name required"
                        : null,
                  ),
                ),
                const SizedBox(height: 22),
                const Text(
                  "Select Avatar",
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    if (_selectedAvatar != null)
                      GroupAvatarAtlas(
                        avatarKey: _selectedAvatar!,
                        size: 56,
                      )
                    else
                      Container(
                        width: 56,
                        height: 56,
                        decoration: BoxDecoration(
                          color: Colors.black.withOpacity(0.05),
                          borderRadius: BorderRadius.circular(14),
                        ),
                        child: const Icon(Icons.image_outlined),
                      ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _pickAvatar,
                        child: Text(
                          _selectedAvatar == null ? "Choose Avatar" : "Change Avatar",
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                      ),
                    ),
                    if (_selectedAvatar != null) ...[
                      const SizedBox(width: 8),
                      IconButton(
                        tooltip: "Clear",
                        onPressed: () => setState(() => _selectedAvatar = null),
                        icon: const Icon(Icons.clear),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 26),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _saving ? null : _save,
                    child: Text(
                      _saving ? "Saving..." : "Create",
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  "Note: make sure the avatar atlas asset is included at "
                  "assets/avatars/group_avatars.png in pubspec.yaml.",
                  style: TextStyle(
                    fontSize: 12,
                    color: SFColors.textPrimary.withOpacity(0.7),
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