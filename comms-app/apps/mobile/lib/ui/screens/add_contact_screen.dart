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
  final _org = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();

  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _org.dispose();
    _phone.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    final name = _name.text.trim();
    final org = _org.text.trim();
    final phone = _phone.text.trim();
    final email = _email.text.trim();

    setState(() => _busy = true);

    try {
      final api = ApiClient(baseUrl: widget.appState.baseUrl);
      final svc = ContactImportService(api, widget.appState);

      final c = Contact(
        id: '', // ✅ do not invent IDs; server is source of truth
        name: name,
        organization: org.isEmpty ? null : org,
        phone: phone.isEmpty ? null : phone,
        email: email.isEmpty ? null : email,
      );

      await svc.importContacts(
        method: 'manual',
        contacts: [c],
      );

      // ✅ refresh from server so UUID + normalized phone show up correctly
      await widget.appState.loadContacts();

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
    return Theme(
      data: SfTheme,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Add Contact'),
          backgroundColor: SFColors.primaryBlue,
          foregroundColor: Colors.white,
        ),
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Form(
              key: _formKey,
              child: ListView(
                children: [
                  TextFormField(
                    controller: _name,
                    decoration: const InputDecoration(
                      labelText: 'Name',
                      prefixIcon: Icon(Icons.person_outline),
                    ),
                    validator: (v) =>
                        (v == null || v.trim().isEmpty) ? 'Name required' : null,
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _org,
                    decoration: const InputDecoration(
                      labelText: 'Organization (optional)',
                      prefixIcon: Icon(Icons.apartment_outlined),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _phone,
                    decoration: const InputDecoration(
                      labelText: 'Phone (optional)',
                      prefixIcon: Icon(Icons.phone_outlined),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _email,
                    decoration: const InputDecoration(
                      labelText: 'Email (optional)',
                      prefixIcon: Icon(Icons.email_outlined),
                    ),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _busy ? null : _save,
                      child: Text(_busy ? 'Saving…' : 'Save Contact'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}