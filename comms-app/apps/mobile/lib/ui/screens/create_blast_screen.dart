// comms-app/apps/mobile/lib/ui/screens/create_blast_screen.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/app_state.dart';
import '../../models/blast.dart';
import '../../services/blasts_api.dart';
import '../../services/api_client.dart';
import '../colors.dart';
import '../icons.dart';
import '../components/sf_card.dart';
import '../components/sf_primary_button.dart';
import '../../models/group.dart';
import 'threads_screen.dart';

class CreateBlastScreen extends StatefulWidget {
  final AppState appState;
  const CreateBlastScreen({super.key, required this.appState});

  @override
  State<CreateBlastScreen> createState() => _CreateBlastScreenState();
}

class _CreateBlastScreenState extends State<CreateBlastScreen> {
  final _formKey = GlobalKey<FormState>();
  final BlastDraft draft = BlastDraft();

  final _nameCtrl = TextEditingController(text: 'Smoke Test');
  final _subjectCtrl = TextEditingController();
  final _bodyCtrl = TextEditingController();

  final _nameFocus = FocusNode();
  final _subjectFocus = FocusNode();
  final _bodyFocus = FocusNode();

  final FocusNode _kbdFocus = FocusNode();

  /// Channels
  final Set<Channel> _channels = {Channel.sms};

  /// Groups (IDs)
  final Set<String> _selectedGroupIds = {};

  bool busy = false;
  String? status;

  bool get hasEmail => _channels.contains(Channel.email);
  bool get hasSms => _channels.contains(Channel.sms);

  @override
  void dispose() {
    _nameCtrl.dispose();
    _subjectCtrl.dispose();
    _bodyCtrl.dispose();
    _nameFocus.dispose();
    _subjectFocus.dispose();
    _bodyFocus.dispose();
    _kbdFocus.dispose();
    super.dispose();
  }

  void _openGroupPicker() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) {
        return StatefulBuilder(
          builder: (context, modalSetState) {
            return _GroupPicker(
              groups: widget.appState.groups,
              selected: _selectedGroupIds,
              onToggle: (id) {
                modalSetState(() {});
                setState(() {
                  _selectedGroupIds.contains(id)
                      ? _selectedGroupIds.remove(id)
                      : _selectedGroupIds.add(id);
                });
              },
            );
          },
        );
      },
    );
  }

  Future<bool> _confirmInternational(String estUsd, bool chargeNow) async {
    return await showDialog<bool>(
          context: context,
          builder: (_) => AlertDialog(
            title: const Text("International SMS charges"),
            content: Text(
              "This blast includes international recipients.\n\n"
              "Estimated international cost: \$$estUsd\n\n"
              "Charges are based on destination and billed to your saved payment method.",
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text("Cancel"),
              ),
              ElevatedButton(
                onPressed: () => Navigator.pop(context, true),
                child: Text(chargeNow ? "Confirm & Charge Now" : "Confirm & Send"),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<void> _send() async {
    setState(() => status = null);

    if (!_formKey.currentState!.validate()) return;

    if (_channels.isEmpty) {
      setState(() => status = 'Select at least one channel.');
      return;
    }

    if (_selectedGroupIds.isEmpty) {
      setState(() => status = 'Select at least one group.');
      return;
    }

    draft.channels = _channels.toSet();
    draft.name = _nameCtrl.text.trim();
    draft.subject = _subjectCtrl.text.trim();
    draft.body = _bodyCtrl.text.trim();
    draft.groupIds = _selectedGroupIds.toList();

    setState(() => busy = true);

    try {
      final apiClient = ApiClient(baseUrl: widget.appState.baseUrl);
      final blastsApi = BlastsApi(apiClient);

      final channels = _channels.map((c) => c == Channel.sms ? "sms" : "email").toList();

      // 1) Quote
      final quote = await blastsApi.quote(
        groupIds: _selectedGroupIds.toList(),
        channels: channels,
        body: draft.body,
      );

      if (quote['blocked'] == true) {
        setState(() => status = 'Blocked: ${quote['blockedReason'] ?? 'not allowed'}');
        return;
      }

      final intlCount = (quote['intlCount'] ?? 0) as int;
      final requiresConfirm = quote['requiresConfirm'] == true;

      if (requiresConfirm && intlCount > 0) {
        final est = quote['estimatedIntlUsd']?.toString() ?? '0.00';
        final chargeNow = quote['requiresImmediateCharge'] == true;

        final ok = await _confirmInternational(est, chargeNow);
        if (!ok) return;
      }

      // 2) Send
      final resp = await blastsApi.send(
        groupIds: _selectedGroupIds.toList(),
        channels: channels,
        body: draft.body,
        quote: quote,
      );

      final blastId = (resp['blastId'] ?? DateTime.now().millisecondsSinceEpoch.toString()).toString();
      setState(() => status = 'Queued ✅ ($blastId)');

      widget.appState.addQueuedBlastAsThread(
        blastId: blastId,
        body: draft.body,
      );

      if (!mounted) return;
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => ThreadsScreen(appState: widget.appState),
        ),
      );
    } catch (e) {
      setState(() => status = 'Error: $e');
    } finally {
      setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final needsSubject = hasEmail;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Create Blast'),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: RawKeyboardListener(
        focusNode: _kbdFocus,
        autofocus: true,
        onKey: (evt) async {
          // Ctrl+Enter sends (desktop/web)
          final isDown = evt is RawKeyDownEvent;
          if (!isDown) return;

          final isEnter = evt.logicalKey == LogicalKeyboardKey.enter ||
              evt.logicalKey == LogicalKeyboardKey.numpadEnter;

          if (!isEnter) return;

          final isCtrl = evt.isControlPressed || evt.isMetaPressed;

          // If in body, plain Enter should be newline (TextFormField handles it).
          // Only Ctrl+Enter triggers send.
          if (isCtrl) {
            await _send();
          }
        },
        child: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Form(
              key: _formKey,
              child: Column(
                children: [
                  SFCard(
                    title: 'Channels',
                    subtitle: 'Select one or both (SMS + Email)',
                    child: Wrap(
                      spacing: 12,
                      children: Channel.values.map((c) {
                        final selected = _channels.contains(c);
                        final label = c == Channel.sms ? 'SMS' : 'Email';

                        return InkWell(
                          borderRadius: BorderRadius.circular(12),
                          onTap: () {
                            setState(() {
                              selected ? _channels.remove(c) : _channels.add(c);
                            });
                          },
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(12),
                              color: selected ? SFColors.primaryBlue : Colors.white,
                              border: Border.all(
                                color: selected ? SFColors.primaryBlue : SFColors.cardBorder,
                              ),
                            ),
                            child: Text(
                              label,
                              style: TextStyle(
                                fontWeight: FontWeight.w700,
                                color: selected ? Colors.white : SFColors.textPrimary,
                              ),
                            ),
                          ),
                        );
                      }).toList(),
                    ),
                  ),

                  const SizedBox(height: 14),

                  SFCard(
                    title: 'Reply mode',
                    subtitle: 'Private = sender only • Group = shared thread',
                    child: _ReplyModeSlider(
                      value: draft.replyMode,
                      onChanged: (v) => setState(() => draft.replyMode = v),
                    ),
                  ),

                  const SizedBox(height: 14),

                  SFCard(
                    title: 'Message',
                    child: Column(
                      children: [
                        TextFormField(
                          controller: _nameCtrl,
                          focusNode: _nameFocus,
                          textInputAction: TextInputAction.next,
                          onFieldSubmitted: (_) => FocusScope.of(context).requestFocus(_subjectFocus),
                          decoration: const InputDecoration(
                            labelText: 'Name',
                            prefixIcon: Icon(Icons.edit_outlined),
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: _subjectCtrl,
                          focusNode: _subjectFocus,
                          textInputAction: TextInputAction.next,
                          onFieldSubmitted: (_) => FocusScope.of(context).requestFocus(_bodyFocus),
                          decoration: InputDecoration(
                            labelText: needsSubject ? 'Subject (required for email)' : 'Subject (email only)',
                            prefixIcon: const Icon(SFIcons.email),
                          ),
                          validator: (v) {
                            if (needsSubject && (v == null || v.trim().isEmpty)) {
                              return 'Subject required when Email is selected.';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: _bodyCtrl,
                          focusNode: _bodyFocus,
                          textInputAction: TextInputAction.newline,
                          keyboardType: TextInputType.multiline,
                          minLines: 4,
                          maxLines: 10,
                          decoration: InputDecoration(
                            labelText: 'Body',
                            helperText: kIsWeb ? 'Tip: Ctrl+Enter to send' : null,
                            prefixIcon: Icon(hasEmail && !hasSms ? SFIcons.email : SFIcons.sms),
                          ),
                          validator: (v) => (v == null || v.trim().isEmpty) ? 'Body is required.' : null,
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 14),

                  SFCard(
                    title: 'Groups',
                    subtitle: 'Select one or more groups',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        OutlinedButton.icon(
                          icon: const Icon(Icons.group),
                          label: const Text('Select Groups'),
                          onPressed: _openGroupPicker,
                        ),
                        if (_selectedGroupIds.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(
                            '${_selectedGroupIds.length} group(s) selected',
                            style: const TextStyle(fontSize: 12),
                          ),
                        ],
                      ],
                    ),
                  ),

                  const SizedBox(height: 16),

                  SizedBox(
                    width: double.infinity,
                    child: SFPrimaryButton(
                      icon: SFIcons.queue,
                      label: busy ? 'Queuing…' : 'Queue Blast',
                      busy: busy,
                      onPressed: busy ? null : _send,
                    ),
                  ),

                  if (status != null) ...[
                    const SizedBox(height: 12),
                    _StatusBanner(text: status!),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _GroupPicker extends StatelessWidget {
  final List<Group> groups;
  final Set<String> selected;
  final ValueChanged<String> onToggle;

  const _GroupPicker({
    required this.groups,
    required this.selected,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Select Groups',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 12),
          ...groups.map((g) {
            final isSelected = selected.contains(g.id);
            return ListTile(
              leading: Icon(
                Icons.group,
                color: isSelected ? SFColors.primaryBlue : Colors.grey,
              ),
              title: Text(g.name),
              subtitle: g.type == "meta" ? const Text("Meta group (dynamic)") : null,
              trailing: isSelected ? const Icon(Icons.check_circle) : null,
              onTap: () => onToggle(g.id),
            );
          }),
        ],
      ),
    );
  }
}

class _ReplyModeSlider extends StatelessWidget {
  final ReplyMode value;
  final ValueChanged<ReplyMode> onChanged;

  const _ReplyModeSlider({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final isPrivate = value == ReplyMode.private;
    return Row(
      children: [
        Expanded(
          child: _chip(
            selected: isPrivate,
            icon: SFIcons.replyPrivate,
            label: 'Private',
            onTap: () => onChanged(ReplyMode.private),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _chip(
            selected: !isPrivate,
            icon: SFIcons.replyGroup,
            label: 'Group',
            onTap: () => onChanged(ReplyMode.group),
          ),
        ),
      ],
    );
  }

  Widget _chip({
    required bool selected,
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          color: selected ? SFColors.primaryBlue : Colors.white,
          border: Border.all(
            color: selected ? SFColors.primaryBlue : Colors.black12,
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: selected ? Colors.white : SFColors.primaryBlue),
            const SizedBox(width: 8),
            Text(
              label,
              style: TextStyle(
                fontWeight: FontWeight.w900,
                color: selected ? Colors.white : SFColors.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusBanner extends StatelessWidget {
  final String text;
  const _StatusBanner({required this.text});

  @override
  Widget build(BuildContext context) {
    final isError = text.toLowerCase().contains('error') ||
        text.toLowerCase().contains('blocked') ||
        text.toLowerCase().contains('required');

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isError ? Colors.redAccent.withOpacity(0.10) : Colors.green.withOpacity(0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: isError ? Colors.redAccent : Colors.green),
      ),
      child: Row(
        children: [
          Icon(
            isError ? SFIcons.warning : Icons.check_circle_outline,
            color: isError ? Colors.redAccent : Colors.green,
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(text)),
        ],
      ),
    );
  }
}