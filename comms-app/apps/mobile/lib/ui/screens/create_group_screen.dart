import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/group.dart';

class CreateGroupScreen extends StatefulWidget {
  final AppState appState;
  const CreateGroupScreen({super.key, required this.appState});

  @override
  State<CreateGroupScreen> createState() => _CreateGroupScreenState();
}

class _CreateGroupScreenState extends State<CreateGroupScreen> {
  final ctrl = TextEditingController();

  void _create() {
    if (ctrl.text.trim().isEmpty) return;

    widget.appState.groups.add(
      Group(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        name: ctrl.text.trim(),
        members: [],
      ),
    );

    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create Group')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(controller: ctrl, decoration: const InputDecoration(labelText: 'Group name')),
            const SizedBox(height: 16),
            ElevatedButton(onPressed: _create, child: const Text('Create')),
          ],
        ),
      ),
    );
  }
}
