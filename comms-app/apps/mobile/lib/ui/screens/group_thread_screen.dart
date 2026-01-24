import 'package:flutter/material.dart';

import '../../models/group_draft.dart';
import '../../models/message.dart';
import '../../services/inbound_service.dart';
import '../colors.dart';
import '../icons.dart';

class GroupThreadScreen extends StatefulWidget {
  final GroupDraft group;

  const GroupThreadScreen({
    super.key,
    required this.group,
  });

  @override
  State<GroupThreadScreen> createState() => _GroupThreadScreenState();
}

class _GroupThreadScreenState extends State<GroupThreadScreen> {
  final TextEditingController _inputCtrl = TextEditingController();
  final List<Message> _messages = [];

  @override
  void initState() {
    super.initState();
    // MVP: preload mock inbound messages
    _messages.addAll(InboundService.mockMessages());
  }

  void _send() {
    final text = _inputCtrl.text.trim();
    if (text.isEmpty) return;

    setState(() {
      _messages.add(
        Message(
          id: DateTime.now().toIso8601String(),
          sender: 'You',
          body: text,
          incoming: false,
          timestamp: DateTime.now(),
        ),
      );
    });

    _inputCtrl.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.group.name),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Center(
              child: Text(
                widget.group.replyMode == ReplyMode.private
                    ? 'Private Replies'
                    : 'Group Replies',
                style: const TextStyle(fontSize: 12),
              ),
            ),
          ),
        ],
      ),
      backgroundColor: SFColors.background,
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.all(12),
              itemCount: _messages.length,
              itemBuilder: (_, i) {
                final m = _messages[i];
                return Align(
                  alignment:
                      m.incoming ? Alignment.centerLeft : Alignment.centerRight,
                  child: Container(
                    margin: const EdgeInsets.symmetric(vertical: 4),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: m.incoming
                          ? Colors.white
                          : SFColors.primaryBlue.withOpacity(0.15),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.black12),
                    ),
                    child: Text(m.body),
                  ),
                );
              },
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _inputCtrl,
                      decoration: const InputDecoration(
                        hintText: 'Type a message…',
                      ),
                    ),
                  ),
                  IconButton(
                    icon: Icon(SFIcons.send),
                    onPressed: _send,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _inputCtrl.dispose();
    super.dispose();
  }
}
