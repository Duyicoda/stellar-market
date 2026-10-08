
#[test]
fn test_appeal_tie_break_respects_method() {
    let env = Env::default();
    env.mock_all_auths();

    let dispute_contract_id = env.register_contract(None, DisputeContract);
    let client = DisputeContractClient::new(&env, &dispute_contract_id);
    let escrow_contract_id = env.register_contract(None, DummyEscrow);
    let reputation_contract_id = env.register_contract(None, MockReputationContract);
    let admin = Address::generate(&env);

    client.initialize(&admin, &reputation_contract_id, &300, &escrow_contract_id);

    for _ in 0..5 {
        client.add_arbitrator(&admin, &Address::generate(&env));
    }

    let user_client = Address::generate(&env);
    let freelancer = Address::generate(&env);

    let dispute_id = client.raise_dispute(
        &1u64,
        &user_client,
        &freelancer,
        &user_client,
        &String::from_str(&env, "Issue"),
        &3u32,
        &Some(TieBreakMethod::FavorClient),
    );

    let assigned = client.get_assigned_arbitrators(&dispute_id);
    client.cast_vote(&dispute_id, &assigned.get(0).unwrap(), &VoteChoice::Client, &String::from_str(&env, "C1"), &0u64);
    client.cast_vote(&dispute_id, &assigned.get(1).unwrap(), &VoteChoice::Client, &String::from_str(&env, "C2"), &0u64);
    client.cast_vote(&dispute_id, &assigned.get(2).unwrap(), &VoteChoice::Client, &String::from_str(&env, "C3"), &0u64);

    let _ = client.resolve_dispute(&dispute_id);

    let appeal_id = client.appeal(&dispute_id, &freelancer);
    
    let arb1 = Address::generate(&env);
    let arb2 = Address::generate(&env);
    let arb3 = Address::generate(&env);
    let arb4 = Address::generate(&env);
    client.cast_appeal_vote(&appeal_id, &arb1, &VoteChoice::Client, &String::from_str(&env, "C"));
    client.cast_appeal_vote(&appeal_id, &arb2, &VoteChoice::Client, &String::from_str(&env, "C"));
    client.cast_appeal_vote(&appeal_id, &arb3, &VoteChoice::Freelancer, &String::from_str(&env, "F"));
    client.cast_appeal_vote(&appeal_id, &arb4, &VoteChoice::Freelancer, &String::from_str(&env, "F"));

    let appeal_status = client.resolve_appeal(&appeal_id);
    assert_eq!(appeal_status, AppealStatus::ResolvedForClient);
}

#[test]
fn test_get_dispute_tally_and_finalize_verdict() {
    let env = Env::default();
    env.mock_all_auths();

    let dispute_contract_id = env.register_contract(None, DisputeContract);
    let client = DisputeContractClient::new(&env, &dispute_contract_id);
    let escrow_contract_id = env.register_contract(None, DummyEscrow);
    let reputation_contract_id = env.register_contract(None, MockReputationContract);
    let admin = Address::generate(&env);

    client.initialize(&admin, &reputation_contract_id, &300, &escrow_contract_id);

    for _ in 0..5 {
        client.add_arbitrator(&admin, &Address::generate(&env));
    }

    let user_client = Address::generate(&env);
    let freelancer = Address::generate(&env);

    let dispute_id = client.raise_dispute(
        &1u64,
        &user_client,
        &freelancer,
        &user_client,
        &String::from_str(&env, "Issue"),
        &3u32,
        &None,
    );

    let assigned = client.get_assigned_arbitrators(&dispute_id);
    
    // Check initial tally is empty
    let tally_before = client.get_dispute_tally(&dispute_id);
    assert_eq!(tally_before.vote_count, 0);

    client.cast_vote(&dispute_id, &assigned.get(0).unwrap(), &VoteChoice::Client, &String::from_str(&env, "C1"), &0u64);
    client.cast_vote(&dispute_id, &assigned.get(1).unwrap(), &VoteChoice::Freelancer, &String::from_str(&env, "F1"), &0u64);
    client.cast_vote(&dispute_id, &assigned.get(2).unwrap(), &VoteChoice::Client, &String::from_str(&env, "C2"), &0u64);

    let tally_after = client.get_dispute_tally(&dispute_id);
    assert_eq!(tally_after.vote_count, 3);
    assert!(tally_after.client_weight > 0);
    assert!(tally_after.freelancer_weight > 0);

    let status = client.finalize_verdict(&dispute_id);
    assert_eq!(status, DisputeStatus::ResolvedForClient);
}

#[test]
fn test_get_arbitrators_returns_voters() {
    let env = Env::default();
    env.mock_all_auths();

    let dispute_contract_id = env.register_contract(None, DisputeContract);
    let client = DisputeContractClient::new(&env, &dispute_contract_id);
    let escrow_contract_id = env.register_contract(None, DummyEscrow);
    let reputation_contract_id = env.register_contract(None, MockReputationContract);
    let admin = Address::generate(&env);

    client.initialize(&admin, &reputation_contract_id, &300, &escrow_contract_id);

    for _ in 0..5 {
        client.add_arbitrator(&admin, &Address::generate(&env));
    }

    let user_client = Address::generate(&env);
    let freelancer = Address::generate(&env);

    let dispute_id = client.raise_dispute(
        &1u64,
        &user_client,
        &freelancer,
        &user_client,
        &String::from_str(&env, "Issue"),
        &3u32,
        &None,
    );

    let assigned = client.get_assigned_arbitrators(&dispute_id);
    
    // Check voters is empty initially
    let voters_before = client.get_arbitrators(&dispute_id);
    assert_eq!(voters_before.len(), 0);

    let voter1 = assigned.get(0).unwrap();
    let voter2 = assigned.get(1).unwrap();

    client.cast_vote(&dispute_id, &voter1, &VoteChoice::Client, &String::from_str(&env, "C1"), &0u64);
    client.cast_vote(&dispute_id, &voter2, &VoteChoice::Freelancer, &String::from_str(&env, "F1"), &0u64);

    let voters_after = client.get_arbitrators(&dispute_id);
    assert_eq!(voters_after.len(), 2);
    assert!(voters_after.contains(voter1));
    assert!(voters_after.contains(voter2));
    assert!(!voters_after.contains(assigned.get(2).unwrap()));
}
