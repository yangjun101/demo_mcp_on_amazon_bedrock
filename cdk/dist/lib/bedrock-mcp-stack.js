"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BedrockMcpStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const iam = require("aws-cdk-lib/aws-iam");
const elbv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const autoscaling = require("aws-cdk-lib/aws-autoscaling");
class BedrockMcpStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Create VPC
        const vpc = new ec2.Vpc(this, 'MCP-VPC', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                }
            ]
        });
        // Create Security Group
        const sg = new ec2.SecurityGroup(this, 'MCP-SG', {
            vpc,
            allowAllOutbound: true,
            description: 'Security group for MCP services'
        });
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(7002), 'FastAPI service');
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8502), 'Streamlit UI');
        // Create IAM Role
        const role = new iam.Role(this, 'EC2-Role', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
            ]
        });
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:ListFoundationModels'
            ],
            resources: ['*']
        }));
        // Create Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, 'MCP-ALB', {
            vpc,
            internetFacing: true
        });
        // Create ALB Listeners
        const fastApiListener = alb.addListener('FastAPI', {
            port: 7002,
            protocol: elbv2.ApplicationProtocol.HTTP
        });
        const streamlitListener = alb.addListener('Streamlit', {
            port: 8502,
            protocol: elbv2.ApplicationProtocol.HTTP
        });
        // Create IAM User for API Access
        const apiUser = new iam.User(this, 'BedrockApiUser', {
            userName: 'bedrock-mcp-api-user'
        });
        apiUser.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:ListFoundationModels'
            ],
            resources: ['*']
        }));
        // Create access key for the user
        const accessKey = new iam.CfnAccessKey(this, 'BedrockApiAccessKey', {
            userName: apiUser.userName
        });
        // Create User Data
        const userData = ec2.UserData.forLinux();
        userData.addCommands('#!/bin/bash', 
        // Set HOME environment variable first
        'export HOME=/root', 
        // Update and install dependencies
        'apt-get update', 'apt-get install -y python3-pip git', 
        // Install Node.js
        'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -', 'apt-get install -y nodejs', 
        // Install UV with error handling and persistent PATH
        'curl -LsSf https://astral.sh/uv/install.sh -o install_uv.sh', 'chmod +x install_uv.sh', './install_uv.sh', 'echo \'export PATH="/root/.cargo/bin:$PATH"\' > /etc/profile.d/uv.sh', 'source /etc/profile.d/uv.sh', 
        // Clone project with retry logic
        'cd /home/ubuntu', 'MAX_RETRIES=3', 'RETRY_COUNT=0', 'while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do', '    git clone https://github.com/xiehust/demo_mcp_on_amazon_bedrock.git && break', '    RETRY_COUNT=$((RETRY_COUNT+1))', '    echo "Git clone attempt $RETRY_COUNT failed, retrying in 5 seconds..."', '    sleep 5', 'done', 
        // Exit if git clone ultimately failed
        '[ ! -d "demo_mcp_on_amazon_bedrock" ] && echo "Failed to clone repository" && exit 1', 'cd demo_mcp_on_amazon_bedrock', 
        // Setup Python environment
        'uv sync', 
        // Configure environment
        'cat > .env << EOL', `AWS_ACCESS_KEY_ID=${accessKey.ref}`, `AWS_SECRET_ACCESS_KEY=${accessKey.attrSecretAccessKey}`, 'AWS_REGION=' + cdk.Stack.of(this).region, 'LOG_DIR=./logs', 'CHATBOT_SERVICE_PORT=8502', 'MCP_SERVICE_HOST=127.0.0.1', 'MCP_SERVICE_PORT=7002', `API_KEY=${cdk.Names.uniqueId(this)}`, 'EOL', 
        // Create necessary directories
        'mkdir -p logs', 'mkdir -p tmp', 
        // Set correct permissions
        'chown -R ubuntu:ubuntu /home/ubuntu/demo_mcp_on_amazon_bedrock', 
        // Setup systemd service
        'cat > /etc/systemd/system/mcp-services.service << EOL', '[Unit]', 'Description=MCP Services', 'After=network.target', '', '[Service]', 'Type=forking', 'User=ubuntu', 'WorkingDirectory=/home/ubuntu/demo_mcp_on_amazon_bedrock', 'ExecStart=/bin/bash start_all.sh', 'ExecStop=/bin/bash stop_all.sh', 'Restart=always', '', '[Install]', 'WantedBy=multi-user.target', 'EOL', 
        // Enable and start service
        'systemctl daemon-reload', 'systemctl enable mcp-services', 'systemctl start mcp-services');
        // Create Auto Scaling Group
        const asg = new autoscaling.AutoScalingGroup(this, 'MCP-ASG', {
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            machineImage: ec2.MachineImage.fromSsmParameter('/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id', { os: ec2.OperatingSystemType.LINUX }),
            userData,
            role,
            securityGroup: sg,
            minCapacity: 1,
            maxCapacity: 1,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
            }
        });
        // Add ASG as target for ALB listeners
        fastApiListener.addTargets('FastAPI-Target', {
            port: 7002,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [asg],
            healthCheck: {
                path: '/docs',
                unhealthyThresholdCount: 2,
                healthyThresholdCount: 5,
                interval: cdk.Duration.seconds(30)
            }
        });
        streamlitListener.addTargets('Streamlit-Target', {
            port: 8502,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [asg],
            healthCheck: {
                path: '/',
                unhealthyThresholdCount: 2,
                healthyThresholdCount: 5,
                interval: cdk.Duration.seconds(30)
            }
        });
        // Stack Outputs
        new cdk.CfnOutput(this, 'FastAPI-Endpoint', {
            value: `http://${alb.loadBalancerDnsName}:7002`,
            description: 'FastAPI Service Endpoint'
        });
        new cdk.CfnOutput(this, 'Streamlit-Endpoint', {
            value: `http://${alb.loadBalancerDnsName}:8502`,
            description: 'Streamlit UI Endpoint'
        });
        // Output the API credentials
        new cdk.CfnOutput(this, 'ApiAccessKeyId', {
            value: accessKey.ref,
            description: 'API Access Key ID'
        });
        new cdk.CfnOutput(this, 'ApiSecretAccessKey', {
            value: accessKey.attrSecretAccessKey,
            description: 'API Secret Access Key'
        });
    }
}
exports.BedrockMcpStack = BedrockMcpStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmVkcm9jay1tY3Atc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvYmVkcm9jay1tY3Atc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsZ0VBQWdFO0FBQ2hFLDJEQUEyRDtBQUczRCxNQUFhLGVBQWdCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixhQUFhO1FBQ2IsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDdkMsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLG1CQUFtQixFQUFFO2dCQUNuQjtvQkFDRSxJQUFJLEVBQUUsUUFBUTtvQkFDZCxVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxNQUFNO29CQUNqQyxRQUFRLEVBQUUsRUFBRTtpQkFDYjtnQkFDRDtvQkFDRSxJQUFJLEVBQUUsU0FBUztvQkFDZixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUI7b0JBQzlDLFFBQVEsRUFBRSxFQUFFO2lCQUNiO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFFSCx3QkFBd0I7UUFDeEIsTUFBTSxFQUFFLEdBQUcsSUFBSSxHQUFHLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDL0MsR0FBRztZQUNILGdCQUFnQixFQUFFLElBQUk7WUFDdEIsV0FBVyxFQUFFLGlDQUFpQztTQUMvQyxDQUFDLENBQUM7UUFFSCxFQUFFLENBQUMsY0FBYyxDQUNmLEdBQUcsQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUFFLEVBQ2xCLEdBQUcsQ0FBQyxJQUFJLENBQUMs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QixFQUFFO1lBQzFDLEtBQUssRUFBRSxVQUFVLEdBQUcsQ0FBQyxtQkFBbUIsT0FBTztZQUMvQyxXQUFXLEVBQUUsMEJBQTBCO1NBQ3hDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLFVBQVUsR0FBRyxDQUFDLG1CQUFtQixPQUFPO1lBQy9DLFdBQVcsRUFBRSx1QkFBdUI7U0FDckMsQ0FBQyxDQUFDO1FBRUgsNkJBQTZCO1FBQzdCLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDeEMsS0FBSyxFQUFFLFNBQVMsQ0FBQyxHQUFHO1lBQ3BCLFdBQVcsRUFBRSxtQkFBbUI7U0FDakMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUM1QyxLQUFLLEVBQUUsU0FBUyxDQUFDLG1CQUFtQjtZQUNwQyxXQUFXLEVBQUUsdUJBQXVCO1NBQ3JDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXBQRCwwQ0FvUEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgZWxidjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgYXV0b3NjYWxpbmcgZnJvbSAnYXdzLWNkay1saWIvYXdzLWF1dG9zY2FsaW5nJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuXG5leHBvcnQgY2xhc3MgQmVkcm9ja01jcFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIFZQQ1xuICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdNQ1AtVlBDJywge1xuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUHVibGljJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1ByaXZhdGUnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsXG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICB9XG4gICAgICBdXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgU2VjdXJpdHkgR3JvdXBcbiAgICBjb25zdCBzZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnTUNQLVNHJywge1xuICAgICAgdnBjLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VjdXJpdHkgZ3JvdXAgZm9yIE1DUCBzZXJ2aWNlcydcbiAgICB9KTtcblxuICAgIHNnLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgZWMyLlBlZXIuYW55SXB2NCgpLFxuICAgICAgZWMyLlBvcnQudGNwKDcwMDIpLFxuICAgICAgJ0Zhc3RBUEkgc2VydmljZSdcbiAgICApO1xuXG4gICAgc2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICBlYzIuUGVlci5hbnlJcHY0KCksXG4gICAgICBlYzIuUG9ydC50Y3AoODUwMiksXG4gICAgICAnU3RyZWFtbGl0IFVJJ1xuICAgICk7XG5cbiAgICAvLyBDcmVhdGUgSUFNIFJvbGVcbiAgICBjb25zdCByb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdFQzItUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlYzIuYW1hem9uYXdzLmNvbScpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnQW1hem9uU1NNTWFuYWdlZEluc3RhbmNlQ29yZScpXG4gICAgICBdXG4gICAgfSk7XG5cbiAgICByb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2s6SW52b2tlTW9kZWwnLFxuICAgICAgICAnYmVkcm9jazpMaXN0Rm91bmRhdGlvbk1vZGVscydcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddXG4gICAgfSkpO1xuXG4gICAgLy8gQ3JlYXRlIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICBjb25zdCBhbGIgPSBuZXcgZWxidjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIodGhpcywgJ01DUC1BTEInLCB7XG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZVxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIEFMQiBMaXN0ZW5lcnNcbiAgICBjb25zdCBmYXN0QXBpTGlzdGVuZXIgPSBhbGIuYWRkTGlzdGVuZXIoJ0Zhc3RBUEknLCB7IFxuICAgICAgcG9ydDogNzAwMixcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFBcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0cmVhbWxpdExpc3RlbmVyID0gYWxiLmFkZExpc3RlbmVyKCdTdHJlYW1saXQnLCB7IFxuICAgICAgcG9ydDogODUwMixcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFBcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBJQU0gVXNlciBmb3IgQVBJIEFjY2Vzc1xuICAgIGNvbnN0IGFwaVVzZXIgPSBuZXcgaWFtLlVzZXIodGhpcywgJ0JlZHJvY2tBcGlVc2VyJywge1xuICAgICAgdXNlck5hbWU6ICdiZWRyb2NrLW1jcC1hcGktdXNlcidcbiAgICB9KTtcblxuICAgIGFwaVVzZXIuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbCcsXG4gICAgICAgICdiZWRyb2NrOkxpc3RGb3VuZGF0aW9uTW9kZWxzJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ11cbiAgICB9KSk7XG5cbiAgICAvLyBDcmVhdGUgYWNjZXNzIGtleSBmb3IgdGhlIHVzZXJcbiAgICBjb25zdCBhY2Nlc3NLZXkgPSBuZXcgaWFtLkNmbkFjY2Vzc0tleSh0aGlzLCAnQmVkcm9ja0FwaUFjY2Vzc0tleScsIHtcbiAgICAgIHVzZXJOYW1lOiBhcGlVc2VyLnVzZXJOYW1lXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgVXNlciBEYXRhXG4gICAgY29uc3QgdXNlckRhdGEgPSBlYzIuVXNlckRhdGEuZm9yTGludXgoKTtcbiAgICB1c2VyRGF0YS5hZGRDb21tYW5kcyhcbiAgICAgICcjIS9iaW4vYmFzaCcsXG4gICAgICBcbiAgICAgIC8vIFNldCBIT01FIGVudmlyb25tZW50IHZhcmlhYmxlIGZpcnN0XG4gICAgICAnZXhwb3J0IEhPTUU9L3Jvb3QnLFxuICAgICAgXG4gICAgICAvLyBVcGRhdGUgYW5kIGluc3RhbGwgZGVwZW5kZW5jaWVzXG4gICAgICAnYXB0LWdldCB1cGRhdGUnLFxuICAgICAgJ2FwdC1nZXQgaW5zdGFsbCAteSBweXRob24zLXBpcCBnaXQnLFxuICAgICAgXG4gICAgICAvLyBJbnN0YWxsIE5vZGUuanNcbiAgICAgICdjdXJsIC1mc1NMIGh0dHBzOi8vZGViLm5vZGVzb3VyY2UuY29tL3NldHVwXzIyLnggfCBiYXNoIC0nLFxuICAgICAgJ2FwdC1nZXQgaW5zdGFsbCAteSBub2RlanMnLFxuICAgICAgXG4gICAgICAvLyBJbnN0YWxsIFVWIHdpdGggZXJyb3IgaGFuZGxpbmcgYW5kIHBlcnNpc3RlbnQgUEFUSFxuICAgICAgJ2N1cmwgLUxzU2YgaHR0cHM6Ly9hc3RyYWwuc2gvdXYvaW5zdGFsbC5zaCAtbyBpbnN0YWxsX3V2LnNoJyxcbiAgICAgICdjaG1vZCAreCBpbnN0YWxsX3V2LnNoJyxcbiAgICAgICcuL2luc3RhbGxfdXYuc2gnLFxuICAgICAgJ2VjaG8gXFwnZXhwb3J0IFBBVEg9XCIvcm9vdC8uY2FyZ28vYmluOiRQQVRIXCJcXCcgPiAvZXRjL3Byb2ZpbGUuZC91di5zaCcsXG4gICAgICAnc291cmNlIC9ldGMvcHJvZmlsZS5kL3V2LnNoJyxcbiAgICAgIFxuICAgICAgLy8gQ2xvbmUgcHJvamVjdCB3aXRoIHJldHJ5IGxvZ2ljXG4gICAgICAnY2QgL2hvbWUvdWJ1bnR1JyxcbiAgICAgICdNQVhfUkVUUklFUz0zJyxcbiAgICAgICdSRVRSWV9DT1VOVD0wJyxcbiAgICAgICd3aGlsZSBbICRSRVRSWV9DT1VOVCAtbHQgJE1BWF9SRVRSSUVTIF07IGRvJyxcbiAgICAgICcgICAgZ2l0IGNsb25lIGh0dHBzOi8vZ2l0aHViLmNvbS94aWVodXN0L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrLmdpdCAmJiBicmVhaycsXG4gICAgICAnICAgIFJFVFJZX0NPVU5UPSQoKFJFVFJZX0NPVU5UKzEpKScsXG4gICAgICAnICAgIGVjaG8gXCJHaXQgY2xvbmUgYXR0ZW1wdCAkUkVUUllfQ09VTlQgZmFpbGVkLCByZXRyeWluZyBpbiA1IHNlY29uZHMuLi5cIicsXG4gICAgICAnICAgIHNsZWVwIDUnLFxuICAgICAgJ2RvbmUnLFxuICAgICAgXG4gICAgICAvLyBFeGl0IGlmIGdpdCBjbG9uZSB1bHRpbWF0ZWx5IGZhaWxlZFxuICAgICAgJ1sgISAtZCBcImRlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrXCIgXSAmJiBlY2hvIFwiRmFpbGVkIHRvIGNsb25lIHJlcG9zaXRvcnlcIiAmJiBleGl0IDEnLFxuICAgICAgXG4gICAgICAnY2QgZGVtb19tY3Bfb25fYW1hem9uX2JlZHJvY2snLFxuICAgICAgXG4gICAgICAvLyBTZXR1cCBQeXRob24gZW52aXJvbm1lbnRcbiAgICAgICd1diBzeW5jJyxcbiAgICAgIFxuICAgICAgLy8gQ29uZmlndXJlIGVudmlyb25tZW50XG4gICAgICAnY2F0ID4gLmVudiA8PCBFT0wnLFxuICAgICAgYEFXU19BQ0NFU1NfS0VZX0lEPSR7YWNjZXNzS2V5LnJlZn1gLFxuICAgICAgYEFXU19TRUNSRVRfQUNDRVNTX0tFWT0ke2FjY2Vzc0tleS5hdHRyU2VjcmV0QWNjZXNzS2V5fWAsXG4gICAgICAnQVdTX1JFR0lPTj0nICsgY2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbixcbiAgICAgICdMT0dfRElSPS4vbG9ncycsXG4gICAgICAnQ0hBVEJPVF9TRVJWSUNFX1BPUlQ9ODUwMicsXG4gICAgICAnTUNQX1NFUlZJQ0VfSE9TVD0xMjcuMC4wLjEnLFxuICAgICAgJ01DUF9TRVJWSUNFX1BPUlQ9NzAwMicsXG4gICAgICBgQVBJX0tFWT0ke2Nkay5OYW1lcy51bmlxdWVJZCh0aGlzKX1gLFxuICAgICAgJ0VPTCcsXG4gICAgICBcbiAgICAgIC8vIENyZWF0ZSBuZWNlc3NhcnkgZGlyZWN0b3JpZXNcbiAgICAgICdta2RpciAtcCBsb2dzJyxcbiAgICAgICdta2RpciAtcCB0bXAnLFxuICAgICAgXG4gICAgICAvLyBTZXQgY29ycmVjdCBwZXJtaXNzaW9uc1xuICAgICAgJ2Nob3duIC1SIHVidW50dTp1YnVudHUgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgIFxuICAgICAgLy8gU2V0dXAgc3lzdGVtZCBzZXJ2aWNlXG4gICAgICAnY2F0ID4gL2V0Yy9zeXN0ZW1kL3N5c3RlbS9tY3Atc2VydmljZXMuc2VydmljZSA8PCBFT0wnLFxuICAgICAgJ1tVbml0XScsXG4gICAgICAnRGVzY3JpcHRpb249TUNQIFNlcnZpY2VzJyxcbiAgICAgICdBZnRlcj1uZXR3b3JrLnRhcmdldCcsXG4gICAgICAnJyxcbiAgICAgICdbU2VydmljZV0nLFxuICAgICAgJ1R5cGU9Zm9ya2luZycsXG4gICAgICAnVXNlcj11YnVudHUnLFxuICAgICAgJ1dvcmtpbmdEaXJlY3Rvcnk9L2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgICdFeGVjU3RhcnQ9L2Jpbi9iYXNoIHN0YXJ0X2FsbC5zaCcsXG4gICAgICAnRXhlY1N0b3A9L2Jpbi9iYXNoIHN0b3BfYWxsLnNoJyxcbiAgICAgICdSZXN0YXJ0PWFsd2F5cycsXG4gICAgICAnJyxcbiAgICAgICdbSW5zdGFsbF0nLFxuICAgICAgJ1dhbnRlZEJ5PW11bHRpLXVzZXIudGFyZ2V0JyxcbiAgICAgICdFT0wnLFxuICAgICAgXG4gICAgICAvLyBFbmFibGUgYW5kIHN0YXJ0IHNlcnZpY2VcbiAgICAgICdzeXN0ZW1jdGwgZGFlbW9uLXJlbG9hZCcsXG4gICAgICAnc3lzdGVtY3RsIGVuYWJsZSBtY3Atc2VydmljZXMnLFxuICAgICAgJ3N5c3RlbWN0bCBzdGFydCBtY3Atc2VydmljZXMnXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBBdXRvIFNjYWxpbmcgR3JvdXBcbiAgICBjb25zdCBhc2cgPSBuZXcgYXV0b3NjYWxpbmcuQXV0b1NjYWxpbmdHcm91cCh0aGlzLCAnTUNQLUFTRycsIHtcbiAgICAgIHZwYyxcbiAgICAgIGluc3RhbmNlVHlwZTogZWMyLkluc3RhbmNlVHlwZS5vZihlYzIuSW5zdGFuY2VDbGFzcy5UMywgZWMyLkluc3RhbmNlU2l6ZS5NRURJVU0pLFxuICAgICAgbWFjaGluZUltYWdlOiBlYzIuTWFjaGluZUltYWdlLmZyb21Tc21QYXJhbWV0ZXIoXG4gICAgICAgICcvYXdzL3NlcnZpY2UvY2Fub25pY2FsL3VidW50dS9zZXJ2ZXIvMjIuMDQvc3RhYmxlL2N1cnJlbnQvYW1kNjQvaHZtL2Vicy1ncDIvYW1pLWlkJyxcbiAgICAgICAgeyBvczogZWMyLk9wZXJhdGluZ1N5c3RlbVR5cGUuTElOVVggfVxuICAgICAgKSxcbiAgICAgIHVzZXJEYXRhLFxuICAgICAgcm9sZSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IHNnLFxuICAgICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgICBtYXhDYXBhY2l0eTogMSxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTU1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEFTRyBhcyB0YXJnZXQgZm9yIEFMQiBsaXN0ZW5lcnNcbiAgICBmYXN0QXBpTGlzdGVuZXIuYWRkVGFyZ2V0cygnRmFzdEFQSS1UYXJnZXQnLCB7XG4gICAgICBwb3J0OiA3MDAyLFxuICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIHRhcmdldHM6IFthc2ddLFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgcGF0aDogJy9kb2NzJyxcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogNSxcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKVxuICAgICAgfVxuICAgIH0pO1xuXG4gICAgc3RyZWFtbGl0TGlzdGVuZXIuYWRkVGFyZ2V0cygnU3RyZWFtbGl0LVRhcmdldCcsIHtcbiAgICAgIHBvcnQ6IDg1MDIsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgdGFyZ2V0czogW2FzZ10sXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICBwYXRoOiAnLycsXG4gICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDUsXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMClcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIFN0YWNrIE91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRmFzdEFQSS1FbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiBgaHR0cDovLyR7YWxiLmxvYWRCYWxhbmNlckRuc05hbWV9OjcwMDJgLFxuICAgICAgZGVzY3JpcHRpb246ICdGYXN0QVBJIFNlcnZpY2UgRW5kcG9pbnQnXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU3RyZWFtbGl0LUVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IGBodHRwOi8vJHthbGIubG9hZEJhbGFuY2VyRG5zTmFtZX06ODUwMmAsXG4gICAgICBkZXNjcmlwdGlvbjogJ1N0cmVhbWxpdCBVSSBFbmRwb2ludCdcbiAgICB9KTtcblxuICAgIC8vIE91dHB1dCB0aGUgQVBJIGNyZWRlbnRpYWxzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwaUFjY2Vzc0tleUlkJywge1xuICAgICAgdmFsdWU6IGFjY2Vzc0tleS5yZWYsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FQSSBBY2Nlc3MgS2V5IElEJ1xuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwaVNlY3JldEFjY2Vzc0tleScsIHtcbiAgICAgIHZhbHVlOiBhY2Nlc3NLZXkuYXR0clNlY3JldEFjY2Vzc0tleSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVBJIFNlY3JldCBBY2Nlc3MgS2V5J1xuICAgIH0pO1xuICB9XG59XG4iXX0=