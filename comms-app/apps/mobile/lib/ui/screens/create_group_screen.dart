import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/group.dart';
import '../colors.dart';

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

  bool _saving = false;
  String? _err;

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _saving = true;
      _err = null;
    });

    try {
      final group = Group(
        id: UniqueKey().toString(),
        name: _nameCtrl.text.trim(),
        type: widget.type,
        memberCount: 0,
        members: const [],
      );

      widget.appState.upsertGroup(group);

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
          child: Column(
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
                  validator: (v) =>
                      (v == null || v.trim().isEmpty)
                          ? "Name required"
                          : null,
                ),
              ),

              const SizedBox(height: 20),

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
            ],
          ),
        ),
      ),
    );
  }
}