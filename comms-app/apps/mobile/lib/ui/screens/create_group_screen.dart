import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../services/groups_api.dart';
import '../colors.dart';
import '../groups/group_avatar_catalog.dart';

class CreateGroupScreen extends StatefulWidget {
  final AppState appState;
  final String type; // "snapshot" or "meta"

  const CreateGroupScreen({
    super.key,
    required this.appState,
    required this.type,
  });

  @override
  State<CreateGroupScreen> createState() =>
      _CreateGroupScreenState();
}

class _CreateGroupScreenState
    extends State<CreateGroupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();

  String? _selectedAvatar;

  bool _saving = false;
  String? _err;

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
        avatarKey: _selectedAvatar,
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
        title: Text(
            isMeta ? "Create Meta Group" : "Create Group"),
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
                    padding:
                        const EdgeInsets.only(bottom: 12),
                    child: Text(
                      _err!,
                      style: const TextStyle(
                          color: Colors.red),
                    ),
                  ),

                Form(
                  key: _formKey,
                  child: TextFormField(
                    controller: _nameCtrl,
                    decoration:
                        const InputDecoration(
                      labelText: "Group Name",
                    ),
                    validator: (v) =>
                        (v == null || v.trim().isEmpty)
                            ? "Name required"
                            : null,
                  ),
                ),

                const SizedBox(height: 24),

                const Text(
                  "Select Avatar",
                  style: TextStyle(
                      fontWeight: FontWeight.w600),
                ),

                const SizedBox(height: 12),

                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: groupAvatarCatalog.map((key) {
                    final selected =
                        _selectedAvatar == key;

                    return ChoiceChip(
                      label: Text(key),
                      selected: selected,
                      onSelected: (_) {
                        setState(
                            () => _selectedAvatar = key);
                      },
                    );
                  }).toList(),
                ),

                const SizedBox(height: 30),

                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed:
                        _saving ? null : _save,
                    child: Text(
                      _saving
                          ? "Saving..."
                          : "Create",
                      style: const TextStyle(
                          fontWeight:
                              FontWeight.w800),
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