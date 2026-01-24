import 'package:flutter/material.dart';
import '../../models/group.dart';
import '../colors.dart';
import '../icons.dart';

class GroupEditorScreen extends StatefulWidget {
  final Group group;
  const GroupEditorScreen({super.key, required this.group});

  @override
  State<GroupEditorScreen> createState() => _GroupEditorScreenState();
}

class _GroupEditorScreenState extends State<GroupEditorScreen> {
  late TextEditingController _nameCtrl;

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController(text: widget.group.name);
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Edit Group'),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(
              controller: _nameCtrl,
              decoration: const InputDecoration(
                labelText: 'Group name',
                prefixIcon: Icon(Icons.group),
              ),
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Icon(SFIcons.contacts, color: SFColors.secondarySlate),
                const SizedBox(width: 8),
                Text(
                  '${widget.group.members.length} members',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ],
            ),
            const Spacer(),
            ElevatedButton.icon(
              icon: const Icon(Icons.save),
              label: const Text('Save Changes'),
              onPressed: () {
                // wire later
                Navigator.pop(context);
              },
            ),
          ],
        ),
      ),
    );
  }
}
