import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../../models/blast.dart';
import '../../services/blast_api.dart';
import '../../services/api_client.dart';
import '../../models/group.dart';

import '../colors.dart';
import '../icons.dart';
import '../components/sf_card.dart';
import '../components/sf_primary_button.dart';

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
    super.dispose();
  }

  // ✅ FIX: Bottom sheet must be able to rebuild itself.
  // We wrap the sheet in StatefulBuilder and update both:
  // - the sheet state (so checkmarks paint immediately)
  // - the parent state (so selected count is preserved)
  void _openGroupPicker() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) {
        return StatefulBuilder(
          builder: (context, sheetSetState) {
            return SafeArea(
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  const Text(
                    'Select Groups',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 12),
                  ...widget.appState.groups.map((g) {
                    final isSelected = _selectedGroupIds.contains(g.id);
                    return ListTile(
                      leading: Icon(
                        Icons.group,
                        color: isSelected ? SFColors.primaryBlue : Colors.grey,
                      ),
                      title: Text(g.name),
                      trailing: isSelected ? const Icon(Icons.check_circle) : null,
                      onTap: () {
                        // update sheet immediately
                        sheetSetState(() {
                          isSelected
                              ? _selectedGroupIds.remove(g.id)
                              : _selectedGroupIds.add(g.id);
                        });
                        // also update parent
                        setState(() {});
                      },
                    );
                  }),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text(
                        'Done',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  // ============================================================
  // 🌍 International confirmation modal
  // ============================================================
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

  // ============================================================
  // 🚀 Send flow: validate → quote → confirm → send
  // ============================================================
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

    // Assign draft fields
    draft.channels = _channels.toSet();
    draft.name = _nameCtrl.text.trim();
    draft.subject = _subjectCtrl.text.trim();
    draft.body = _bodyCtrl.text.trim();
    draft.groupIds = _selectedGroupIds.toList();

    setState(() => busy = true);

    try {
      final apiClient = ApiClient(baseUrl: widget.appState.baseUrl);
      final blastsApi = BlastsApi(apiClient);

      // TEMP until auth is wired
      const userId = 'dev-user';

      // NOTE: still using placeholder recipients (as in your current file)
      final recipients = _selectedGroupIds.map((id) => '+1555000$id').toList();

      final quote = await blastsApi.quote(
        userId: userId,
        recipients: recipients,
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

      final resp = await blastsApi.send(
        userId: userId,
        recipients: recipients,
        body: draft.body,
        quote: quote,
      );

      setState(() => status = 'Queued ✅ (${resp['blastId'] ?? ''})');
    } catch (e) {
      setState(() => status = 'Error: $e');
    } finally {
      setState(() => busy = false);
    }
  }

  // ============================================================
  // UI
  // ============================================================
  @override
  Widget build(BuildContext context) {
    final needsSubject = hasEmail;

    return Scaffold(
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
                        decoration: const InputDecoration(
                          labelText: 'Name',
                          prefixIcon: Icon(Icons.edit_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _subjectCtrl,
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
                        minLines: 4,
                        maxLines: 8,
                        decoration: InputDecoration(
                          labelText: 'Body',
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
