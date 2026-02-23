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
    super.dispose();
  }

  void _openGroupPicker() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) {
        // ✅ local modal state so checkmarks update immediately
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

  List<String> _channelsToApiList() {
    final out = <String>[];
    if (_channels.contains(Channel.sms)) out.add("sms");
    if (_channels.contains(Channel.email)) out.add("email");
    return out;
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

    // Assign draft fields (UI only)
    draft.channels = _channels.toSet();
    draft.name = _nameCtrl.text.trim();
    draft.subject = _subjectCtrl.text.trim();
    draft.body = _bodyCtrl.text.trim();
    draft.groupIds = _selectedGroupIds.toList();

    final channelsApi = _channelsToApiList();

    setState(() => busy = true);

    try {
      final apiClient = ApiClient(baseUrl: widget.appState.baseUrl);
      final blastsApi = BlastsApi(apiClient);

      // 1️⃣ Quote (server resolves recipients from groupIds/contactIds)
      final quote = await blastsApi.quote(
        groupIds: draft.groupIds,
        channels: channelsApi,
        body: draft.body,
      );

      if (quote['blocked'] == true) {
        setState(() => status = 'Blocked: ${quote['blockedReason'] ?? 'not allowed'}');
        return;
      }

      final intlCount = (quote['intlCount'] ?? 0) as int;
      final requiresConfirm = quote['requiresConfirm'] == true;

      // 2️⃣ Confirm intl charges if required
      if (requiresConfirm && intlCount > 0) {
        final est = quote['estimatedIntlUsd']?.toString() ?? '0.00';
        final chargeNow = quote['requiresImmediateCharge'] == true;

        final ok = await _confirmInternational(est, chargeNow);
        if (!ok) return;
      }

      // 3️⃣ Send
      final resp = await blastsApi.send(
        groupIds: draft.groupIds,
        channels: channelsApi,
        body: draft.body,
        quote: quote,
      );

      final blastId = (resp['blastId'] ?? DateTime.now().millisecondsSinceEpoch.toString()).toString();
      setState(() => status = 'Queued ✅ ($blastId)');

      // Local thread placeholder so Threads tab is testable
      widget.appState.addQueuedBlastAsThread(
        blastId: blastId,
        body: draft.body,
      );

      if (!mounted) return;
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => ThreadsScreen(appState: widget.appState)),
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

    // Ctrl+Enter to send (desktop/web/windows)
    final shortcuts = <ShortcutActivator, Intent>{
      const SingleActivator(LogicalKeyboardKey.enter, control: true): const _SendIntent(),
      const SingleActivator(LogicalKeyboardKey.numpadEnter, control: true): const _SendIntent(),
    };

    final actions = <Type, Action<Intent>>{
      _SendIntent: CallbackAction<_SendIntent>(
        onInvoke: (_) {
          if (!busy) _send();
          return null;
        },
      ),
    };

    return Shortcuts(
      shortcuts: shortcuts,
      child: Actions(
        actions: actions,
        child: Focus(
          autofocus: true,
          child: Scaffold(
            appBar: AppBar(
              title: const Text('Create Blast'),
              backgroundColor: SFColors.primaryBlue,
              foregroundColor: Colors.white,
            ),
            body: SafeArea(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: Form(
                  key: _formKey,
                  child: Column(
                    children: [
                      /// CHANNELS
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

                      /// REPLY MODE
                      SFCard(
                        title: 'Reply mode',
                        subtitle: 'Private = sender only • Group = shared thread',
                        child: _ReplyModeSlider(
                          value: draft.replyMode,
                          onChanged: (v) => setState(() => draft.replyMode = v),
                        ),
                      ),

                      const SizedBox(height: 14),

                      /// MESSAGE
                      SFCard(
                        title: 'Message',
                        child: Column(
                          children: [
                            TextFormField(
                              controller: _nameCtrl,
                              focusNode: _nameFocus,
                              textInputAction: TextInputAction.next,
                              onFieldSubmitted: (_) => _subjectFocus.requestFocus(),
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
                              onFieldSubmitted: (_) => _bodyFocus.requestFocus(),
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
                              minLines: 4,
                              maxLines: 8,
                              keyboardType: TextInputType.multiline,
                              textInputAction: TextInputAction.newline,
                              decoration: InputDecoration(
                                labelText: 'Body',
                                helperText: kIsWeb ? 'Ctrl+Enter to send' : null,
                                prefixIcon: Icon(hasEmail && !hasSms ? SFIcons.email : SFIcons.sms),
                              ),
                              validator: (v) => (v == null || v.trim().isEmpty) ? 'Body is required.' : null,
                            ),
                          ],
                        ),
                      ),

                      const SizedBox(height: 14),

                      /// GROUPS
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

                      /// SEND
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
        ),
      ),
    );
  }
}

class _SendIntent extends Intent {
  const _SendIntent();
}

/// ============================================================
/// GROUP PICKER (single definition only)
/// ============================================================

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
              trailing: isSelected ? const Icon(Icons.check_circle) : null,
              onTap: () => onToggle(g.id),
            );
          }),
        ],
      ),
    );
  }
}

/// ============================================================
/// REPLY MODE
/// ============================================================

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

/// ============================================================
/// STATUS BANNER
/// ============================================================

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