import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../../models/contact.dart';
import '../../services/api_client.dart';
import '../../services/contact_import_service.dart';
import '../colors.dart';
import '../theme/sf_theme.dart';

class AddContactScreen extends StatefulWidget {
  final AppState appState;
  const AddContactScreen({super.key, required this.appState});

  @override
  State<AddContactScreen> createState() => _AddContactScreenState();
}

class _AddContactScreenState extends State<AddContactScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();

  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    final name = _name.text.trim();
    final phone = _phone.text.trim();
    final email = _email.text.trim();

    final c = Contact(
      id: 'manual_${DateTime.now().millisecondsSinceEpoch}',
      name: name,
      phone: phone.isEmpty ? null : phone,
      email: email.isEmpty ? null : email,
    );

    setState(() => _busy = true);

    try {
      final api = ApiClient(baseUrl: widget.appState.baseUrl);
      final svc = ContactImportService(api);

      await svc.importContacts(
        method: 'manual',
        contacts: [c],
      );

      // local update
      widget.appState.contacts.add(c);
      widget.appState.notifyListeners();

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Contact saved ✅')),
      );
      Navigator.pop(context);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Save failed: $e')),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        elevation: 0,
        flexibleSpace: Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [SFColors.headerBlueDark, SFColors.headerBlueLight],
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
            ),
          ),
        ),
        title: const Text('Add Contact', style: TextStyle(fontWeight: FontWeight.w700)),
        foregroundColor: Colors.white,
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Name'),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Name required' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _phone,
                decoration: const InputDecoration(labelText: 'Phone (optional)'),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _email,
                decoration: const InputDecoration(labelText: 'Email (optional)'),
                validator: (v) {
                  if (v == null || v.trim().isEmpty) return null;
                  final ok = v.contains('@') && v.contains('.');
                  return ok ? null : 'Invalid email';
                },
              ),
              const Spacer(),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _busy ? null : _save,
                  style: FilledButton.styleFrom(
                    backgroundColor: SFColors.primaryBlue,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(SFTheme.radiusMd),
                    ),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  child: Text(
                    _busy ? 'Saving…' : 'Save Contact',
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
